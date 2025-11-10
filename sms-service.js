  /**
 * SMS Service - Node.js Module
 * Sends SMS notifications via SMS Bayim API
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// SMS API Configuration - SMS Bayim (loaded from shared config)
const smsConfigFile = fs.readFileSync(path.join(__dirname, 'sms-config.json'), 'utf8');
const smsConfigData = JSON.parse(smsConfigFile);
const SMS_CONFIG = {
  API_URL: smsConfigData.api_url,
  USERNAME: smsConfigData.username,
  PASSWORD: smsConfigData.password,
  ORIGINATOR: smsConfigData.originator,
  TYPE: smsConfigData.type,
  ENABLED: smsConfigData.enabled
};

const LOG_FILE = path.join(__dirname, 'sms_log.txt');

/**
 * Log SMS to file
 */
function logSMS(phone, message, response = null) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Phone: ${phone} | Message: ${message}${response ? ' | Response: ' + response : ''}\n`;
  
  try {
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    console.error('Failed to write SMS log:', error);
  }
}

/**
 * Clean phone number
 */
function cleanPhoneNumber(phone) {
  // Remove all non-numeric characters
  phone = phone.replace(/[^0-9]/g, '');
  
  // Remove leading +90, 90, or 0
  if (phone.startsWith('90')) {
    phone = phone.substring(2);
  } else if (phone.startsWith('0')) {
    phone = phone.substring(1);
  }
  
  return phone;
}

/**
 * Send SMS via SMS Bayim API
 */
async function sendSMS(phone, message) {
  // Log the SMS attempt
  logSMS(phone, message);
  
  // If SMS is not enabled, just log and return success
  if (!SMS_CONFIG.ENABLED) {
    return { success: true, message: 'SMS logged (API disabled)' };
  }
  
  // Validate credentials
  if (!SMS_CONFIG.USERNAME || !SMS_CONFIG.PASSWORD || !SMS_CONFIG.ORIGINATOR) {
    return { success: false, error: 'SMS API credentials not configured' };
  }
  
  // Clean phone number
  const cleanedPhone = cleanPhoneNumber(phone);
  
  if (!cleanedPhone || cleanedPhone.length < 10) {
    return { success: false, error: 'Invalid phone number' };
  }
  
  // Build XML request
  const xmlData = `data=<sms>
<kulad>${SMS_CONFIG.USERNAME}</kulad>
<sifre>${SMS_CONFIG.PASSWORD}</sifre>
<gonderen>${SMS_CONFIG.ORIGINATOR}</gonderen>
<mesaj>${escapeXml(message)}</mesaj>
<numaralar>${cleanedPhone}</numaralar>
<tur>${SMS_CONFIG.TYPE}</tur>
</sms>`;
  
  return new Promise((resolve) => {
    const url = new URL(SMS_CONFIG.API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(xmlData)
      },
      rejectUnauthorized: false
    };
    
    const protocol = url.protocol === 'https:' ? https : http;
    
    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        logSMS(cleanedPhone, message, data);
        
        // Check if response indicates success
        // SMS Bayim returns: "1:ID:Gonderildi:1:XXX" for success
        if (res.statusCode === 200 && (data.includes('OK') || data.includes('success') || data.includes('Gonderildi'))) {
          resolve({ success: true, message: 'SMS sent successfully', response: data });
        } else {
          resolve({ success: false, error: `SMS API response: ${data}`, statusCode: res.statusCode });
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('SMS API error:', error);
      resolve({ success: false, error: `SMS API connection error: ${error.message}` });
    });
    
    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ success: false, error: 'SMS API request timeout' });
    });
    
    req.write(xmlData);
    req.end();
  });
}

/**
 * Escape XML special characters
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Send ticket creation notification
 */
async function sendTicketCreatedSMS(phone, ticketId, title) {
  const message = `Your ticket #${ticketId} '${title}' has been created. We will respond shortly.`;
  return sendSMS(phone, message);
}

/**
 * Send new message notification
 */
async function sendNewMessageSMS(phone, ticketId, sender) {
  const message = `New message from ${sender} on ticket #${ticketId}. Please check your account.`;
  return sendSMS(phone, message);
}

/**
 * Send ticket status update notification
 */
async function sendTicketStatusUpdateSMS(phone, ticketId, title, oldStatus, newStatus) {
  const statusText = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
  const message = `Ticket #${ticketId} '${title}' status updated to: ${statusText}. Check your account for details.`;
  return sendSMS(phone, message);
}

module.exports = {
  sendSMS,
  sendTicketCreatedSMS,
  sendNewMessageSMS,
  sendTicketStatusUpdateSMS
};
