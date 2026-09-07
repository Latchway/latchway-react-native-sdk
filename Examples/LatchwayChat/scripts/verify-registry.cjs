const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  assert(!pkg.link, 'Local dependency link: ' + location);
  assert(!/^(file:|link:|workspace:)/.test(pkg.resolved || ''), 'Local dependency: ' + location);
}
for (const name of ['@latchway/react-native', '@latchway/client', '@latchway/langchain']) {
  const location = 'node_modules/' + name;
  const pkg = lock.packages[location];
  assert.equal(pkg.version, name === '@latchway/client' ? '1.0.0' : '1.1.0');
  assert.equal(new URL(pkg.resolved).origin, 'https://registry.npmjs.org');
  assert(pkg.integrity.startsWith('sha512-'));
  assert.equal(fs.realpathSync(path.join(root, location)), path.join(root, location));
  const installed = JSON.parse(fs.readFileSync(path.join(root, location, 'package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  console.log(name + '@' + pkg.version + ' — npm registry, integrity locked, no local link');
}
const podLock = path.join(root, 'ios/Podfile.lock');
if (fs.existsSync(podLock)) {
  const pods = fs.readFileSync(podLock, 'utf8');
  assert(pods.includes('Latchway/AppAttest (1.0.0)'));
  assert(!/\n  Latchway:\n    :path:/.test(pods));
  console.log('Native iOS: CocoaPods Latchway/AppAttest 1.0.0 (no local SDK override)');
}
