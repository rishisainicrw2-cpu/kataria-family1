// Central configuration. Everything secret comes from environment variables or files in DATA_DIR — never from frontend code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function persistedSecret(name, bytes = 32) {
  const envName = name.toUpperCase();
  if (process.env[envName]) return process.env[envName];
  const file = path.join(DATA_DIR, name + '.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const v = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

module.exports = {
  PORT: +process.env.PORT || 3000,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'kataria.sqlite'),
  // Public https URL of the deployed app (needed for the Google OAuth redirect). Example: https://kataria.example.com
  BASE_URL: (process.env.BASE_URL || '').replace(/\/$/, ''),
  SECRET_KEY: persistedSecret('secret_key'),   // encrypts the stored Google refresh token
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  // The existing Drive folder supplied by the owner. Override with DRIVE_ROOT_FOLDER_ID if ever needed.
  DRIVE_ROOT_FOLDER_ID: process.env.DRIVE_ROOT_FOLDER_ID || '19c1XVBgxeafcZpllGh2GA3ap2wk6BHUO',
  MAX_UPLOAD_MB: +process.env.MAX_UPLOAD_MB || 50,
  SESSION_DAYS: 30,
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
};
module.exports.persistedSecret = persistedSecret;
