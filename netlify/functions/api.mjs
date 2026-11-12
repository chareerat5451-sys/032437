import { getStore } from '@netlify/blobs';
import { handle } from './lib/core.mjs';

export default async (req, context) => {
  const store = getStore({ name: 'muaythai-final-exam', consistency: 'strong' });
  return handle(req, {
    store,
    now: Date.now(),
    env: { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, TOKEN_SECRET: process.env.TOKEN_SECRET },
    ip: context?.ip || req.headers.get('x-nf-client-connection-ip') || '',
  });
};

export const config = { path: '/api/*' };
