const fs = require('fs');
const axios = require('axios');
const WebSocket = require('ws');
const EventEmitter = require('eventemitter3');
const { ReadableStream } = require('stream/web');
const https = require('https');
const http = require('http');
const FormData = require('form-data');

// Configuration Constants
const API_BASE_URL = 'https://example.3cx.com.au'; // Replace with your 3CX PBX API base URL
const APP_ID = 'nafistest'; // Replace with your App ID
const APP_SECRET = '##################'; // Replace  App Secret
const DN_NUMBER = '111'; // manual setup for now - add extension number thats dialing out
const AUDIO_FILE = '.../path//'; // Path to your .wav audio file

// Event Emitter for WebSocket events
const eventEmitter = new EventEmitter();

// Function to receive access token
async function receiveToken() {
    const tokenUrl = `${API_BASE_URL}/connect/token`;
    const formParams = new FormData();
    formParams.append('client_id', APP_ID);
    formParams.append('client_secret', APP_SECRET);
    formParams.append('grant_type', 'client_credentials');

    try {
        const response = await axios.post(tokenUrl, formParams, {
            headers: formParams.getHeaders(),
        });
        return `Bearer ${response.data.access_token}`;
    } catch (error) {
        console.error('Error fetching token:', error.response?.data || error.message);
        throw new Error('Unable to receive access token');
    }
}

// Function to fetch participant status
async function getParticipantStatus(participantId, token) {
    try {
        const response = await axios.get(`${API_BASE_URL}/callcontrol/${DN_NUMBER}/participants/${participantId}`, {
            headers: {
                Authorization: token,
            },
        });
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
            request.write(chunk);
        }
        request.end();
    } catch (error) {
        console.error('Error during streaming:', error.message);
        request.abort();
    }
}

// Function to stream WAV audio to a participant
async function playWavAudio(participantId, token) {
    try {
        console.log(`Preparing to stream WAV audio to participant ID: ${participantId}`);

        if (!fs.existsSync(AUDIO_FILE)) {
            throw new Error(`Audio file not found: ${AUDIO_FILE}`);
        }

        const audioStream = fs.createReadStream(AUDIO_FILE);
        const readableStream = new ReadableStream({
            start(controller) {
                audioStream.on('data', (chunk) => controller.enqueue(chunk));
                audioStream.on('end', () => controller.close());
                audioStream.on('error', (error) => controller.error(error));
            },
        });

        const cancelationToken = {
            on: (event, callback) => {
                if (event === 'cancel') process.on('SIGINT', callback);
            },
        };

        await postAudioStream(DN_NUMBER, participantId, readableStream, cancelationToken, token);
        console.log('Audio streamed successfully.');
    } catch (error) {
        console.error('Error streaming WAV audio:', error.message);
    }
}

// WebSocket handler
async function setupWebSocket(token) {
    console.log('Setting up WebSocket connection...');
    const ws = new WebSocket(`${API_BASE_URL}/callcontrol/ws`, {
        headers: { Authorization: token },
    });

    ws.on('open', () => {
        console.log('WebSocket connected.');
        ws.send(JSON.stringify({ action: 'subscribe', path: '/callcontrol' }));
        console.log('Subscribed to /callcontrol path.');
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('WebSocket message received:', data);

            const { event_type, entity } = data.event;

            if (event_type === 0 && entity.includes('participants')) {
                const participantId = entity.split('/').pop();
                console.log(`Detected participant change. Participant ID: ${participantId}`);

                const status = await getParticipantStatus(participantId, token);
                console.log(`Participant ${participantId} status: ${status}`);

                if (status === 'Connected') {
                    console.log(`Participant is connected. Streaming audio to participant ID: ${participantId}`);
                    await playWavAudio(participantId, token);
                } else {
                    console.log(`Participant status ${status} is not ready for streaming.`);
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error.message);
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
    });

    ws.on('close', () => {
        console.log('WebSocket closed. Reconnecting in 5 seconds...');
        setTimeout(() => setupWebSocket(token), 5000);
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
        const token = await receiveToken();
        await setupWebSocket(token);

    } catch (error) {
        console.error('Error initializing application:', error.message);
        process.exit(1);
    }
}

// Start the application
main();
