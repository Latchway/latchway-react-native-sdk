import {Platform} from 'react-native';
import {getAuth, getIdToken, onAuthStateChanged, onIdTokenChanged} from '@react-native-firebase/auth';
import {Latchway, type LatchwayApp} from '@latchway/react-native';
import {config, validateConfig} from './config';
import {ChatAccountLifecycle} from './account-lifecycle';
import {FirebaseIdentitySnapshots} from './firebase-identity-snapshot';

const auth = getAuth();
const identitySnapshots = new FirebaseIdentitySnapshots(() => ({
  appName: auth.app.name, issuer: 'https://securetoken.google.com/' + auth.app.options.projectId,
  tenant: auth.tenantId ?? null, user: auth.currentUser,
}), user => getIdToken(user));
// The configured identity owner outlives screens. These observers only fence
// callback pairing; they neither activate nor authenticate another account.
onAuthStateChanged(auth, user => identitySnapshots.observe(user));
onIdTokenChanged(auth, user => identitySnapshots.observe(user));
export const identitySnapshotDiagnostic = () => identitySnapshots.diagnostic();
let pendingApp: Promise<LatchwayApp> | undefined;

// One owner per application, outside React effect/screen lifetimes. Firebase's
// already-configured native app is reused; no second Firebase app is created.
export function sharedApp(): Promise<LatchwayApp> {
  if (!pendingApp) {
    validateConfig();
    const issuer = 'https://securetoken.google.com/' + auth.app.options.projectId;
    pendingApp = Latchway.configure({
      baseURL: config.baseURL, applicationID: config.applicationID,
      environment: config.environment, identityProvider: 'firebase',
      identity: {name: 'latchway-chat-firebase', issuer, tenant: auth.tenantId ?? undefined},
      getIdentitySnapshot: () => identitySnapshots.snapshot(),
      apple: {
        rootKeychainAccessGroup: config.appleTeamID + '.' + config.appleBundleID,
        appAttestEnabled: true, softwareKeyFallbackPolicy: 'disallow',
        // This chat demo has never provisioned delegated extension credentials.
        legacyComponents: [],
      },
      android: Platform.OS === 'android' ? {
        playIntegrityCloudProjectNumber: config.androidPlayIntegrityProjectNumber,
        keyPolicy: 'hardware_backed_required',
      } : undefined,
    }, 'latchway-chat').catch(error => { pendingApp = undefined; throw error; });
  }
  return pendingApp;
}

export const accounts = new ChatAccountLifecycle(sharedApp);

/** Only the explicit sign-out action may capture a persisted generation on a
 * cold launch. Delayed auth notifications retire only their already-held scope. */
export async function signOutLatchway(): Promise<void> {
  const snapshot = await (await sharedApp()).snapshot();
  await accounts.logout(snapshot.generationID);
}

let observedIdentity = identityKey();
let identityCleanup: Promise<void> = Promise.resolve();
function identityKey(): string {
  return JSON.stringify([auth.app.name, auth.tenantId, auth.currentUser?.uid ?? null]);
}
/** Both the observer and explicit sign-in converge on one serialized transition. */
export function reconcileIdentity(): Promise<void> {
  const next = identityKey();
  if (next !== observedIdentity) {
    observedIdentity = next;
    identityCleanup = accounts.identityChanged();
  }
  return identityCleanup;
}
