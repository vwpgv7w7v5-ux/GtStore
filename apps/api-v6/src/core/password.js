import crypto from 'node:crypto';
const iterations = 120000;
export const hashPassword = password => {
  const salt = crypto.randomBytes(16); const digest = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`;
};
export const verifyPassword = (password, stored) => {
  const [kind, rounds, saltHex, digestHex] = String(stored).split('$'); if (kind !== 'pbkdf2') return false;
  const digest = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), Number(rounds), 32, 'sha256');
  const expected = Buffer.from(digestHex, 'hex'); return digest.length === expected.length && crypto.timingSafeEqual(digest, expected);
};
