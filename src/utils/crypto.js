import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes is standard for GCM

// Initialization: Validate the key
const keyBase64 = process.env.SHOPIFY_CREDENTIAL_ENCRYPTION_KEY;
if (!keyBase64) {
  console.error("FATAL: SHOPIFY_CREDENTIAL_ENCRYPTION_KEY is not defined in environment variables.");
  console.error("Generate a secure key using: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  process.exit(1);
}

const ENCRYPTION_KEY = Buffer.from(keyBase64, 'base64');

if (ENCRYPTION_KEY.length !== 32) {
  console.error(`FATAL: SHOPIFY_CREDENTIAL_ENCRYPTION_KEY decoded length is ${ENCRYPTION_KEY.length} bytes, but expected exactly 32 bytes.`);
  process.exit(1);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string} text - The plaintext to encrypt.
 * @returns {string} - The encrypted string in format base64(iv):base64(authTag):base64(ciphertext)
 */
export function encrypt(text) {
  if (!text) return text;
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  
  let ciphertext = cipher.update(text, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext}`;
}

/**
 * Decrypts an encrypted string created by the encrypt function.
 * @param {string} encryptedText - The formatted encrypted string.
 * @returns {string} - The decrypted plaintext.
 */
export function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encryption format. Expected iv:authTag:ciphertext');
  }
  
  const [ivBase64, authTagBase64, ciphertextBase64] = parts;
  
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(ciphertextBase64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
