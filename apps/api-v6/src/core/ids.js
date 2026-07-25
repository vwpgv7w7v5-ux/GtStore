import crypto from 'node:crypto';
export const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const timingSafeEqual = (a, b) => {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
