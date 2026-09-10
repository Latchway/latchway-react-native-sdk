import {Platform} from 'react-native';
import {getAuth, getIdToken, onAuthStateChanged, onIdTokenChanged} from '@react-native-firebase/auth';
import {Latchway, firebaseProject, type LatchwayApp} from '@latchway/react-native';
import {config, validateConfig} from './config';
import {ChatAccountLifecycle} from './account-lifecycle';
import {FirebaseIdentitySnapshots} from './firebase-identity-snapshot';

const auth = getAuth();
const identitySnapshots = new FirebaseIdentitySnapshots(() => ({
  appName: auth.app.name, issuer: 'https://securetoken.google.com/' + auth.app.options.projectId,
  tenant: auth.tenantId ?? null, user: auth.currentUser,
}), user => getIdToken(user));
export const identitySnapshotDiagnostic = () => identitySnapshots.diagnostic();
let pendingApp: Promise<LatchwayApp> | undefined;

// One owner per application, outside React effect/screen lifetimes. Firebase's
// already-configured native app is reused; no second Firebase app is created.
export function sharedApp(): Promise<LatchwayApp> {
  if (!pendingApp) {
    validateConfig();
    const projectID = auth.app.options.projectId;
    if (!projectID) throw new Error('The application must configure its Firebase project ID.');
    pendingApp = Latchway.configure({
      baseURL: config.baseURL, applicationID: config.applicationID,
      environment: config.environment,
      identity: firebaseProject({projectID, tenantID: auth.tenantId ?? undefined}),
      apple: {
        rootKeychainAccessGroup: config.appleTeamID + '.' + config.appleBundleID,
        appAttestEnabled: true, softwareKeyFallbackPolicy: 'disallow',
      },
      android: Platform.OS === 'android' ? {
        playIntegrityCloudProjectNumber: config.androidPlayIntegrityProjectNumber,
        keyPolicy: 'hardware_backed_required',
      } : undefined,
    }, 'latchway-chat').catch(error => { pendingApp = undefined; throw error; });
  }
  return pendingApp;
}

// Firebase is this example application's dependency, never Latchway's. This is
// a one-shot token producer; native stores verified identity after JS stops.
export const accounts = new ChatAccountLifecycle(sharedApp, async () => {
  const snapshot = await identitySnapshots.snapshot();
  if (!snapshot) throw new Error('The application could not supply a current ID token.');
  return snapshot.token;
});

onAuthStateChanged(auth, user => identitySnapshots.observe(user));
onIdTokenChanged(auth, user => {
  identitySnapshots.observe(user);
  // Same-account refresh only; explicit login/Resume is the only sign-in intent.
  void reconcileIdentity().then(() => user ? accounts.refreshIdentity() : undefined)
    .catch(() => {}); // A failed refresh remains suspended; the next chat action retries visibly.
});

/** Explicit application logout needs no account lookup, including cold launch
 * or interrupted cleanup. Delayed auth events retire only their held scope. */
export function signOutLatchway(): Promise<void> {
  return accounts.signOut();
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
