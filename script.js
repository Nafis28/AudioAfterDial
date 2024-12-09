const fs = require('fs');
const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('eventemitter3');
const { ReadableStream } = require('stream/web');
const https = require('https');
const http = require('http');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
require('dotenv').config(); // If using environment variables

// Configuration Constants
const API_BASE_URL = process.env.API_BASE_URL || 'https://example.3cx.com.au'; // 3CX PBX API base URL
const APP_ID = process.env.APP_ID; // App ID
const APP_SECRET = process.env.APP_SECRET; // App Secret
const DN_NUMBER = process.env.DN_NUMBER || '111'; // Extension number dialing out
const AUDIO_FILE = process.env.AUDIO_FILE || 'C:/Users/n_a_f/Documents/Aatrox/CPA/Webhook/Nafismusic_compatible.wav'; // Path to .wav audio file

// Event Emitter for WebSocket events
const eventEmitter = new EventEmitter();

// Token variable
let accessToken = '';

// Function to receive access token
async function receiveToken() {
    const tokenUrl = `${API_BASE_URL}/connect/token`;
    const formParams = new FormData();
    formParams.append('client_id', APP_ID);
    formParams.append('client_secret', APP_SECRET);
    formParams.append('grant_type', 'client_credentials');
    // Append scope if required
    // formParams.append('scope', 'required_scope_here'); 

    try {
        const response = await axios.post(tokenUrl, formParams, {
            headers: formParams.getHeaders(),
        });
        accessToken = `Bearer ${response.data.access_token}`;
        console.log(`[receiveToken] Access token received: ${accessToken.substring(0, 30)}...`);
        return accessToken;
    } catch (error) {
        console.error('Error fetching token:', error.response?.data || error.message);
        throw new Error('Unable to receive access token');
    }
}

// Function to validate if token is expired
function isTokenExpired(token) {
    try {
        const decoded = jwt.decode(token.split(' ')[1]);
        const currentTime = Math.floor(Date.now() / 1000);
        const expired = decoded.exp < currentTime;
        if (expired) {
            console.log('[isTokenExpired] Token has expired.');
        }
        return expired;
    } catch (error) {
        console.error('[isTokenExpired] Error decoding token:', error.message);
        return true;
    }
}

// Function to make authenticated GET requests with automatic token refresh
async function authenticatedGet(url) {
    if (isTokenExpired(accessToken)) {
        console.log('[authenticatedGet] Token expired. Refreshing token...');
        await receiveToken();
    }

    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: accessToken,
            },
        });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.warn('[authenticatedGet] Received 401. Refreshing token and retrying...');
            await receiveToken();
            const retryResponse = await axios.get(url, {
                headers: {
                    Authorization: accessToken,
                },
            });
            return retryResponse.data;
        } else {
            throw error;
        }
    }
}

// Function to fetch participant status
async function getParticipantStatus(participantId, token) {
    try {
        const response = await authenticatedGet(`${API_BASE_URL}/callcontrol/${DN_NUMBER}/participants/${participantId}`);
        return response.data.status; 
    } catch (error) {
        console.error(`Error fetching status for participant ${participantId}:`, error.response?.data || error.message);
        return null;
    }
}

// Function to make a call
async function makeCall(source, destination, token) {
    try {
        const response = await axios.post(`${API_BASE_URL}/callcontrol/${source}/makecall`, {
            destination: destination,
        }, {
            headers: {
                Authorization: token,
                'Content-Type': 'application/json',
            },
        });
        return response.data.participantId; 
    } catch (error) {
        console.error('Error making call:', error.response?.data || error.message);
        throw error;
    }
}

// Helper function for chunked reading
async function* readChunks(reader) {
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
    }
}

// Function to stream WAV audio using postAudioStream
async function postAudioStream(source, participantId, bodyStream, cancelationToken, token) {
    const controller = new AbortController();
    const signal = controller.signal;

    const url = `/callcontrol/${source}/participants/${participantId}/stream`;
    const reader = bodyStream.getReader();
    const urlPbx = new URL(API_BASE_URL);

    const options = {
        hostname: urlPbx.hostname,
        port: urlPbx.port || (urlPbx.protocol === 'https:' ? 443 : 80),
        path: url,
        protocol: urlPbx.protocol,
        method: 'POST',
        agent: urlPbx.protocol === 'https:' ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true }),
        headers: {
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked',
            Authorization: token,
        },
    };

    let request;
    if (urlPbx.protocol === 'http:') {
        request = http.request(options);
    } else if (urlPbx.protocol === 'https:') {
        request = https.request(options);
    }

    if (!request) {
        throw new Error('Unable to create HTTP/HTTPS request.');
    }

    cancelationToken.on('cancel', () => {
        controller.abort();
        request.abort();
    });

    request.on('error', (error) => {
        console.error('Stream error:', error.message);
        reader.cancel();
    });

    request.on('response', (response) => {
        console.log(`HTTP response status: ${response.statusCode}`);
        response.on('data', (data) => console.log('Response body:', data.toString()));
        response.on('end', () => console.log('Stream response ended.'));
    });

    try {
        for await (const chunk of readChunks(reader)) {
            console.log(`[postAudioStream] Writing chunk of size: ${chunk.length}`);
            request.write(chunk);
        }
        request.end();
        console.log('[postAudioStream] All chunks written. Ending request.');
    } catch (error) {
        console.error('Error during streaming:', error.message);
        request.abort();
    }
}

// Function to stream WAV audio to a participant with enhanced logging
async function playWavAudio(participantId, token) {
    try {
        console.log(`[playWavAudio] Preparing to stream WAV audio to participant ID: ${participantId}`);

        // Check if the audio file exists
        if (!fs.existsSync(AUDIO_FILE)) {
            console.error(`[playWavAudio] Error: Audio file not found at path: ${AUDIO_FILE}`);
            throw new Error(`Audio file not found: ${AUDIO_FILE}`);
        }
        console.log(`[playWavAudio] Audio file found: ${AUDIO_FILE}`);

        // Create a readable stream for the audio file
        const audioStream = fs.createReadStream(AUDIO_FILE);
        console.log(`[playWavAudio] Audio stream created for file: ${AUDIO_FILE}`);

        // Create a ReadableStream wrapper
        const readableStream = new ReadableStream({
            start(controller) {
                console.log(`[playWavAudio] Starting to read audio stream...`);
                audioStream.on('data', (chunk) => {
                    console.log(`[playWavAudio] Read chunk of size: ${chunk.length}`);
                    controller.enqueue(chunk);
                });
                audioStream.on('end', () => {
                    console.log(`[playWavAudio] Audio stream reading completed.`);
                    controller.close();
                });
                audioStream.on('error', (error) => {
                    console.error(`[playWavAudio] Error reading audio stream: ${error.message}`);
                    controller.error(error);
                });
            },
        });

        // Create a cancellation token for handling interruptions
        const cancelationToken = {
            on: (event, callback) => {
                if (event === 'cancel') {
                    process.on('SIGINT', callback);
                    console.log(`[playWavAudio] Cancellation token registered for SIGINT.`);
                }
            },
        };

        // Log start of the streaming process
        console.log(`[playWavAudio] Starting to stream audio to participant ID: ${participantId}`);
        await postAudioStream(DN_NUMBER, participantId, readableStream, cancelationToken, token);

        // Log success message
        console.log(`[playWavAudio] Audio streamed successfully to participant ID: ${participantId}`);
    } catch (error) {
        // Log detailed error message
        console.error(`[playWavAudio] Error streaming WAV audio to participant ID ${participantId}: ${error.message}`);
    }
}

// WebSocket handler with participant state tracking and token refresh
async function setupWebSocket(token) {
    console.log('Setting up WebSocket connection...');
    const ws = new WebSocket(`${API_BASE_URL}/callcontrol/ws`, {
        headers: { Authorization: token },
    });

    // Maintain a map to track participant statuses
    const participantStates = new Map();

    ws.on('open', () => {
        console.log(`[WebSocket] Connection established at ${new Date().toISOString()}`);
    });

    ws.on('message', async (data) => {
        console.log(`[WebSocket] Message received at ${new Date().toISOString()}`);
        try {
            const eventData = JSON.parse(data.toString());
            console.log('[WebSocket] Parsed message data:', JSON.stringify(eventData, null, 2));

            // Check if the message contains a participant entity
            const entityPath = eventData?.event?.entity;
            if (entityPath && entityPath.includes('/participants/')) {
                console.log(`[WebSocket] Participant entity detected: ${entityPath}`);

                const participantId = entityPath.split('/').pop();

                try {
                    // Fetch participant details using authenticatedGet
                    const participantData = await authenticatedGet(`${API_BASE_URL}${entityPath}`);

                    const { id, status, callid, party_caller_name, party_dn } = participantData;

                    // Log participant details only if the status has changed
                    if (participantStates.get(id) !== status) {
                        participantStates.set(id, status); // Update the status
                        console.log(`[WebSocket] Updated Participant Details:
    - Participant ID: ${id}
    - Status: ${status}
    - Caller Name: ${party_caller_name || 'N/A'}
    - Called DN: ${party_dn}
    - Call ID: ${callid}`);
                    }

                    // Handle connected status
                    if (status === 'Connected') {
                        console.log(`[WebSocket] Participant ${id} is connected. Preparing to stream audio.`);
                        await playWavAudio(participantId, accessToken);
                    }
                } catch (error) {
                    console.error(`[WebSocket] Error fetching details for entity ${entityPath}:`, 
                                  error.response?.data || error.message);
                }
            } else {
                console.log('[WebSocket] Message does not contain participant entity. Full data:', eventData);
            }
        } catch (error) {
            console.error('[WebSocket] Error processing message:', error.message, data.toString());
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[WebSocket] Connection closed at ${new Date().toISOString()}.
        Code: ${code}, Reason: ${reason}`);
        console.log('Attempting to reconnect in 5 seconds...');
        setTimeout(() => setupWebSocket(accessToken), 5000);
    });

    ws.on('error', (error) => {
        console.error(`[WebSocket] Error at ${new Date().toISOString()}:`, error.message);
        ws.close();
    });
}

// Main function
async function main() {
    console.log('Starting the application...');

    if (!fs.existsSync(AUDIO_FILE)) {
        console.error(`Audio file not found: ${AUDIO_FILE}`);
        process.exit(1);
    }

    console.log(`Audio file located: ${AUDIO_FILE}`);

    try {
        await receiveToken();
        await setupWebSocket(accessToken);
    } catch (error) {
        console.error('Error initializing application:', error.message);
        process.exit(1);
    }
}

// Start the application
main();
