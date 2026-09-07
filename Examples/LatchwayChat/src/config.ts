import local from './config.local.json';

export const config = Object.freeze(local);
export function validateConfig() {
  const url = new URL(config.baseURL);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(config.applicationID)
  ) {
    throw new Error(
      'Configure src/config.local.json with your HTTPS gateway and application ID.',
    );
  }
}
