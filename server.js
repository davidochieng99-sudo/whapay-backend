const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ========== M-PESA CONFIGURATION (Replace with your sandbox/live credentials) ==========
const MPESA_CONSUMER_KEY = 'YOUR_CONSUMER_KEY';
const MPESA_CONSUMER_SECRET = 'YOUR_CONSUMER_SECRET';
const MPESA_PASSKEY = 'YOUR_PASSKEY';
const MPESA_SHORTCODE = '174379'; // Sandbox default

// ========== Helper: Get M-PESA Access Token ==========
async function getMpesaToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` } }
    );
    return response.data.access_token;
}

// ========== Endpoint: M-PESA STK Push ==========
app.post('/stkpush', async (req, res) => {
    try {
        const { phone, amount, accountReference } = req.body;
        const token = await getMpesaToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: MPESA_SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: amount,
                PartyA: phone,
                PartyB: MPESA_SHORTCODE,
                PhoneNumber: phone,
                CallBackURL: 'https://your-render-url.onrender.com/callback',
                AccountReference: accountReference || 'WhaPay',
                TransactionDesc: 'Payment'
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        
        res.json(response.data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ========== Endpoint: M-PESA Callback ==========
app.post('/callback', (req, res) => {
    console.log('Payment callback:', req.body);
    res.send('OK');
});

// ========== Endpoint: Twilio SMS Handler ==========
app.post('/sms', (req, res) => {
    const incomingMessage = req.body.Body;
    const fromNumber = req.body.From;
    
    if (incomingMessage && incomingMessage.toLowerCase().startsWith('reg')) {
        const name = incomingMessage.substring(4).trim();
        const tempCode = Math.floor(10000 + Math.random() * 90000);
        const responseMessage = `Hi ${name}, your temporary code is ${tempCode}. Send ACTIVATE ${tempCode} on WhatsApp to complete registration.`;
        res.send(`<Response><Message>${responseMessage}</Message></Response>`);
    } else {
        res.send(`<Response><Message>Send REG YourName to register offline.</Message></Response>`);
    }
});

// ========== Endpoint: Twilio Voice Handler ==========
app.post('/voice', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Say>You have reached WhaPay. To register, send an SMS with REG YourName to this number. You will receive a temporary code. Then send ACTIVATE code on WhatsApp to complete registration.</Say>
        <Record maxLength="60" action="/voicemail-callback" />
    </Response>`;
    res.set('Content-Type', 'text/xml').send(twiml);
});

app.post('/voicemail-callback', (req, res) => {
    console.log('Voicemail received:', req.body);
    res.send('<Response/>');
});

app.get('/', (req, res) => {
    res.send('WhaPay backend is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
