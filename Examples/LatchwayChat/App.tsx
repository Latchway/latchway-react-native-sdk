import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from '@react-native-firebase/auth';
import {
  LatchwayClient,
  QuotaSnapshot,
  ReactNativeDiagnostics,
  SDK_VERSION,
} from '@latchway/react-native';
import type { BaseMessage } from '@langchain/core/messages';
import { config, validateConfig } from './src/config';
import {accounts, identitySnapshotDiagnostic, reconcileIdentity, signOutLatchway} from './src/latchway-app';
import {diagnosticLocation, knownFailure} from './src/diagnostic';
import {chatErrorDetail} from './src/error-display';
import {runExistingIdentityProbe} from './src/diagnostic-probe';
import {
  directTurn,
  featureFor,
  langchainTurn,
  Mode,
  ToolEvent,
  TurnResult,
} from './src/chat';

type Bubble = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
};
type Receipt = Record<string, string | number | boolean | string[]>;
const auth = getAuth();
const proof = __DEV__ ? NativeModules.LatchwayChatProof : undefined;

function errorCode(error: unknown) {
  const details = error as {code?: unknown; error?: {code?: unknown}; cause?: {code?: unknown}};
  for (const code of [details?.code, details?.error?.code, details?.cause?.code]) {
    if (typeof code === 'string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(code)) return code;
  }
  return error instanceof Error
    ? error.name
    : 'request_failed';
}
function friendly(error: unknown) {
  const code = errorCode(error);
  if (code === 'AbortError') return 'Stopped. No automatic retry was sent.';
  if (code.startsWith('auth/'))
    return (
      (
        {
          'auth/email-already-in-use':
            'That email already has an account. Choose Sign in.',
          'auth/invalid-email': 'Enter a valid email address.',
          'auth/weak-password':
            'Choose a stronger password (at least 8 characters).',
          'auth/invalid-credential': 'Email or password is incorrect.',
          'auth/network-request-failed':
            'Firebase could not connect. Check your network.',
          'auth/too-many-requests':
            'Too many attempts. Please try again later.',
        } as Record<string, string>
      )[code] ?? 'Firebase sign-in failed. Please try again.'
    );
  return chatErrorDetail(error) ?? (
    'Request failed (' +
    code +
    '). Check Settings for connection details. No automatic retry was sent.'
  );
}
function Button({
  title,
  onPress,
  disabled,
  quiet,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        quiet && styles.quiet,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, quiet && styles.quietText]}>
        {title}
      </Text>
    </Pressable>
  );
}

function ChatApp() {
  const [user, setUser] =
    useState<ReturnType<typeof getAuth>['currentUser']>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mode, setMode] = useState<Mode>('langchain');
  const [draft, setDraft] = useState('');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [tools, setTools] = useState<ToolEvent[]>([]);
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<ReactNativeDiagnostics>();
  const [quota, setQuota] = useState<QuotaSnapshot>();
  const [proofStatus, setProofStatus] = useState('');
  const client = useRef<LatchwayClient | undefined>(undefined);
  const histories = useRef<BaseMessage[][]>([]);
  const directHistory = useRef<
    { role: 'user' | 'assistant'; content: string }[]
  >([]);
  const abort = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const proofStarted = useRef(false);
  const diagnosticStarted = useRef(false);
  const sequence = useRef(0);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    const unlisten = accounts.subscribe(() => {
      abort.current?.abort();
      client.current = undefined;
      clearConversation();
      setDiagnostics(undefined);
      setQuota(undefined);
    });
    const unauth = onAuthStateChanged(auth, value => {
        void reconcileIdentity().catch(e => setError(friendly(e)));
        setUser(value);
        setLoading(false);
      });
    return () => { unlisten(); unauth(); };
  }, []);
  useEffect(
    () => () => {
      abort.current?.abort();
      void accounts.disposeSurface().catch(() => {});
    },
    [],
  );

  async function connection() {
    validateConfig();
    if (!auth.currentUser) throw new Error('Sign in first.');
    client.current = await accounts.connection();
    await client.current.ready;
    return client.current;
  }
  function clearConversation() {
    histories.current = [];
    directHistory.current = [];
    setBubbles([]);
    setTools([]);
    setError('');
  }
  async function inspect(selected: Mode) {
    const sdk = await connection();
    const details = await sdk.diagnostics();
    setDiagnostics(details);
    const allowance = await sdk.quota(featureFor(selected));
    setQuota(allowance);
    return { details, allowance };
  }
  async function login() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (signup)
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      else await signInWithEmailAndPassword(auth, email.trim(), password);
      await reconcileIdentity();
      await accounts.activate();
      setPassword('');
      clearConversation();
    } catch (e) {
      setError(friendly(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      // Offline local logout first; Firebase remains application-owned.
      await signOutLatchway();
      client.current = undefined;
      await signOut(auth);
      clearConversation();
      setDiagnostics(undefined);
      setQuota(undefined);
      setSettings(false);
    } catch (e) {
      setError(friendly(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function send(prompt: string, selected: Mode): Promise<TurnResult> {
    if (running.current || !prompt.trim() || prompt.length > 4000)
      throw new Error('Invalid or busy turn.');
    running.current = true;
    setBusy(true);
    setError('');
    setTools([]);
    const controller = new AbortController();
    abort.current = controller;
    const timer = setTimeout(() => controller.abort(), 120_000);
    const userID = ++sequence.current,
      assistantID = ++sequence.current;
    setBubbles(old => [
      ...old.slice(-18),
      { id: userID, role: 'user', text: prompt },
      { id: assistantID, role: 'assistant', text: '', pending: true },
    ]);
    const onText = (text: string) =>
      setBubbles(old =>
        old.map(item => (item.id === assistantID ? { ...item, text } : item)),
      );
    const onTool = (event: ToolEvent) =>
      setTools(old => [...old.slice(-11), event]);
    let stage = 'connection';
    try {
      const sdk = await connection();
      const epoch = accounts.capture();
      const currentText = (text: string) => { if (accounts.isCurrent(epoch)) onText(text); };
      const currentTool = (event: ToolEvent) => { if (accounts.isCurrent(epoch)) onTool(event); };
      stage = selected === 'langchain' ? 'langchain' : 'direct-fetch';
      const result =
        selected === 'langchain'
          ? await langchainTurn(
              sdk,
              histories.current.flat(),
              prompt,
              controller.signal,
              currentText,
              currentTool,
              value => { stage = value; },
            )
          : await directTurn(
              sdk,
              directHistory.current,
              prompt,
              controller.signal,
              currentText,
            );
      if (!accounts.isCurrent(epoch)) throw new Error('Account changed; old answer discarded.');
      // Keep complete turns, including tool results, rather than dangling tool-call fragments.
      if (selected === 'langchain')
        histories.current = [...histories.current.slice(-3), result.messages];
      else
        directHistory.current = [
          ...directHistory.current.slice(-6),
          { role: 'user', content: prompt },
          { role: 'assistant', content: result.text },
        ];
      setBubbles(old =>
        old.map(item =>
          item.id === assistantID
            ? { ...item, text: result.text, pending: false }
            : item,
        ),
      );
      await inspect(selected).catch(() => setError('Answer completed. Connection details could not refresh; retry them in Settings.'));
      proof?.recordDiagnostic?.({status: 'passed', stage: 'complete',
        sdkVersion: SDK_VERSION, sourceCandidate: 'shared-native-supplied-identity',
        modelCalls: result.modelCalls, toolCalls: result.toolCalls,
        requestIDs: result.requestIDs, finishedAt: new Date().toISOString()});
      return result;
    } catch (e) {
      controller.abort();
      setError(friendly(e) + ' Stage: ' + stage + '.');
      const status = (e as {status?: unknown})?.status;
      // Read local diagnostics only: do not refresh, query quota or retry a
      // failed dispatch just to discover the platform attestation failure.
      const details = await client.current?.diagnostics().catch(() => undefined);
      if (details) setDiagnostics(details);
      proof?.recordDiagnostic?.({status: 'failed', stage, errorCode: knownFailure(e) ?? errorCode(e),
        ...(details ? {attestationSupport: details.attestation.support,
          attestationOperation: details.attestation.lastOperation ?? 'none', keyStorage: details.keyStorage} : {}),
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? {httpStatus: status} : {}),
        errorSite: diagnosticLocation(e), finishedAt: new Date().toISOString()});
      setBubbles(old =>
        old.map(item =>
          item.id === assistantID
            ? {
                ...item,
                pending: false,
                text: item.text
                  ? item.text +
                    '\n\n[Incomplete — not saved in conversation context]'
                  : 'No completed answer.',
              }
            : item,
        ),
      );
      // Failed/aborted messages never become context and are not automatically replayed.
      if (client.current)
        setDiagnostics(
          await client.current.diagnostics().catch(() => undefined),
        );
      throw e;
    } finally {
      clearTimeout(timer);
      abort.current = undefined;
      running.current = false;
      setBusy(false);
    }
  }
  async function verify() {
    const receipt: Receipt = {
      status: 'running',
      stage: 'firebase',
      signup: false,
      signin: false,
    };
    const save = (stage: string) => {
      receipt.stage = stage;
      proof?.record(receipt);
      setProofStatus(stage);
    };
    try {
      save('firebase');
      if (auth.currentUser) {
        await signOutLatchway();
        client.current = undefined;
        await signOut(auth);
      }
      const entropy = Array.from(
        crypto.getRandomValues(new Uint8Array(24)),
        n => n.toString(16).padStart(2, '0'),
      ).join('');
      const address = 'latchway-rn-' + Date.now() + '@example.com';
      const pass = entropy + 'Aa1!';
      const account = await createUserWithEmailAndPassword(auth, address, pass);
      receipt.signup = true;
      receipt.firebaseUID = account.user.uid;
      await signOut(auth);
      await signInWithEmailAndPassword(auth, address, pass);
      await reconcileIdentity();
      await accounts.activate();
      receipt.signin = true;
      save('langchain-first-turn');
      const first = await send(
        'Use weather_check to check Singapore weather now. Briefly explain how Latchway secures this request.',
        'langchain',
      );
      if (first.toolCalls < 1 || !first.text.trim())
        throw new Error('First weather tool was not used.');
      receipt.firstTurn = true;
      receipt.toolCalls = first.toolCalls;
      receipt.modelCalls = first.modelCalls;
      receipt.requestIDs = first.requestIDs;
      save('langchain-followup');
      const second = await send(
        'What about Ho Chi Minh City? Check its weather too, and compare with the previous city.',
        'langchain',
      );
      if (second.toolCalls < 1 || !second.text.trim())
        throw new Error('Follow-up weather tool was not used.');
      receipt.followup = true;
      receipt.toolCalls = first.toolCalls + second.toolCalls;
      receipt.modelCalls = first.modelCalls + second.modelCalls;
      receipt.requestIDs = [...first.requestIDs, ...second.requestIDs];
      const { details, allowance } = await inspect('langchain');
      Object.assign(receipt, {
        installationID: details.installation.id ?? '',
        trustLevel: details.attestation.trustLevel ?? '',
        keyStorage: details.keyStorage,
        platform: details.platform,
        sdkVersion: details.sdkVersion,
        nativeSDKVersion: details.nativeSDKVersion,
        quotaUsed:
          allowance.limits.find(item => item.metric === 'total_tokens')?.used ??
          0,
      });
      if (
        details.attestation.trustLevel !== 'app_verified' ||
        details.keyStorage !== 'secure_enclave'
      ) {
        throw new Error('Required native device trust was not observed.');
      }
      save('direct-fetch');
      const direct = await send(
        'In two sentences, explain why a mobile app must not contain an upstream provider key.',
        'direct',
      );
      receipt.direct = !!direct.text.trim();
      receipt.requestIDs = [
        ...first.requestIDs,
        ...second.requestIDs,
        ...direct.requestIDs,
      ];
      receipt.status = 'passed';
      receipt.finishedAt = new Date().toISOString();
      await inspect('langchain');
      save('complete');
    } catch (e) {
      receipt.status = 'failed';
      receipt.errorCode = errorCode(e);
      proof?.record(receipt);
      // Record stack locations only, not the exception message or provider body.
      if (e instanceof Error)
        receipt.errorSite =
          e.stack?.split('\n').slice(1, 5).join('\n').slice(0, 500) || '';
      proof?.record(receipt);
      setProofStatus(
        'Failed at ' + receipt.stage + ' (' + receipt.errorCode + ')',
      );
      setError(friendly(e));
    }
  }
  useEffect(() => {
    if (proof?.enabled && !proofStarted.current) {
      proofStarted.current = true;
      void verify();
    }
    // Opt-in launch automation, exactly once; uses the same send/auth/native SDK paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!proof?.diagnoseEnabled || proof?.enabled || loading || diagnosticStarted.current) return;
    diagnosticStarted.current = true;
    // This explicit Debug launch request resumes the existing identity before
    // send owns a controller. It never signs out Firebase or creates an account.
    void runExistingIdentityProbe({
      debug: __DEV__, diagnoseEnabled: Boolean(proof?.diagnoseEnabled),
      verificationEnabled: Boolean(proof?.enabled), hasIdentity: Boolean(user),
      reconcileIdentity, activate: () => accounts.activate(), send,
      reportSignInRequired: () => proof?.recordDiagnostic?.({status: 'blocked', stage: 'sign-in-required'}),
      reportActivationFailure: failure => {
        proof?.recordDiagnostic?.({status: 'failed', stage: 'activation',
          errorCode: knownFailure(failure) ?? errorCode(failure),
          ...identitySnapshotDiagnostic(),
          errorSite: diagnosticLocation(failure), finishedAt: new Date().toISOString()});
        setError(friendly(failure) + ' Stage: activation.');
      },
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  const allowance = quota?.limits.find(item => item.metric === 'total_tokens');
  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void send(text, mode).catch(() => {});
  };
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>LATCHWAY / REACT NATIVE</Text>
          <Text style={styles.title}>LatchwayChat</Text>
        </View>
        {user && (
          <Button
            title="Settings"
            quiet
            disabled={busy}
            onPress={() => setSettings(true)}
          />
        )}
      </View>
      <View style={styles.trustRow}>
        <View
          style={[
            styles.dot,
            diagnostics?.attestation.trustLevel === 'app_verified' &&
              styles.verified,
          ]}
        />
        <Text style={styles.muted}>
          {diagnostics?.attestation.trustLevel === 'app_verified'
            ? 'App Attest verified · Secure Enclave'
            : 'Firebase identity + native device trust'}
        </Text>
      </View>
      {!!proofStatus && (
        <Text accessibilityLiveRegion="polite" style={styles.proof}>
          Device check: {proofStatus}
        </Text>
      )}
      {loading ? (
        <ActivityIndicator color="#77e6c5" />
      ) : !user ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.auth}
        >
          <Text style={styles.hero}>Your gateway.\nA real conversation.</Text>
          <Text style={styles.description}>
            Sign in with Firebase to explore Latchway and try a real weather
            tool. Your conversation stays in memory.
          </Text>
          <Text style={styles.label}>Email</Text>
          <TextInput
            accessibilityLabel="Email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!busy}
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            accessibilityLabel="Password"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType={signup ? 'newPassword' : 'password'}
            editable={!busy}
          />
          <Button
            title={busy ? 'Connecting…' : signup ? 'Create account' : 'Sign in'}
            disabled={
              busy || !email.trim() || password.length < (signup ? 8 : 1)
            }
            onPress={() => {
              void login();
            }}
          />
          <Button
            quiet
            title={
              signup
                ? 'Already have an account? Sign in'
                : 'New here? Create an account'
            }
            disabled={busy}
            onPress={() => {
              setSignup(!signup);
              setError('');
            }}
          />
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
        </KeyboardAvoidingView>
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.body}
        >
          <View style={styles.modeRow}>
            <Text style={styles.mode}>
              {mode === 'langchain'
                ? 'LANGCHAIN + WEATHER TOOL'
                : 'DIRECT FETCH'}
            </Text>
            <Text style={styles.muted}>
              {allowance
                ? (allowance.remaining ?? 0).toLocaleString() + ' tokens left'
                : '100k tokens / day'}
            </Text>
          </View>
          <Button title="Resume chat" quiet disabled={busy} onPress={() => {
            void accounts.activate().then(() => inspect(mode)).catch(e => setError(friendly(e)));
          }} />
          <ScrollView
            ref={scroll}
            style={styles.messages}
            contentContainerStyle={styles.messagesContent}
            onContentSizeChange={() =>
              scroll.current?.scrollToEnd({ animated: true })
            }
            keyboardShouldPersistTaps="handled"
          >
            {!bubbles.length && (
              <View style={styles.welcome}>
                <Text style={styles.hero}>Meet your gateway.</Text>
                <Text style={styles.description}>
                  Ask how Latchway works, then watch LangChain call a weather
                  tool through your own gateway.
                </Text>
                {[
                  'How does Latchway protect provider keys?',
                  'Check the weather in Singapore.',
                ].map(text => (
                  <Button
                    key={text}
                    quiet
                    title={text}
                    disabled={busy}
                    onPress={() => {
                      void send(text, mode).catch(() => {});
                    }}
                  />
                ))}
              </View>
            )}
            {bubbles.map(item => (
              <View
                key={item.id}
                style={[
                  styles.bubble,
                  item.role === 'user' && styles.userBubble,
                ]}
              >
                <Text style={styles.bubbleLabel}>
                  {item.role === 'user' ? 'YOU' : 'LATCHWAY'}
                </Text>
                <Text selectable style={styles.messageText}>
                  {item.text || 'Connecting securely…'}
                </Text>
                {item.pending && (
                  <ActivityIndicator
                    style={styles.spinner}
                    color="#77e6c5"
                    size="small"
                  />
                )}
              </View>
            ))}
            {tools.map((event, i) => (
              <View key={i} style={styles.tool}>
                <Text style={styles.toolTitle}>
                  ☀ weather_check · {event.city}
                </Text>
                <Text style={styles.muted}>
                  {event.summary ?? 'Fetching current weather…'}
                </Text>
              </View>
            ))}
            {!!error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
          </ScrollView>
          <View style={styles.composer}>
            <TextInput
              accessibilityLabel="Message"
              multiline
              maxLength={4000}
              style={[styles.input, styles.messageInput]}
              placeholder="Ask about Latchway…"
              placeholderTextColor="#849692"
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
            />
            <Button
              title={busy ? 'Stop' : 'Send'}
              disabled={!busy && !draft.trim()}
              onPress={busy ? () => abort.current?.abort() : sendDraft}
            />
          </View>
          <Text style={styles.footer}>
            Temporary chat · Weather: Open-Meteo / GeoNames
          </Text>
        </KeyboardAvoidingView>
      )}
      <Modal
        visible={settings}
        animationType="slide"
        onRequestClose={() => setSettings(false)}
      >
        <SafeAreaView style={styles.screen}>
          <ScrollView contentContainerStyle={styles.sheet}>
            <Text style={styles.title}>Settings</Text>
            <Text style={styles.description}>
              Both modes use the same native Latchway transport. Changing mode
              starts a new conversation.
            </Text>
            {(['langchain', 'direct'] as const).map(value => (
              <Button
                key={value}
                title={
                  (mode === value ? '✓ ' : '') +
                  (value === 'langchain'
                    ? 'LangChain + weather tool'
                    : 'Direct fetch')
                }
                quiet={mode !== value}
                disabled={busy}
                onPress={() => {
                  setMode(value);
                  clearConversation();
                  setQuota(undefined);
                }}
              />
            ))}
            <Text style={styles.label}>CONNECTION</Text>
            <Text selectable style={styles.description}>
              {config.baseURL}\n{config.environment}\n{user?.email}
            </Text>
            <Text selectable style={styles.code}>
              {JSON.stringify(
                {
                  trust:
                    diagnostics?.attestation.trustLevel ?? 'not established',
                  keys: diagnostics?.keyStorage,
                  sdk: diagnostics?.sdkVersion,
                  nativeSDK: diagnostics?.nativeSDKVersion,
                  platform: diagnostics?.platform,
                  requestID: diagnostics?.server.lastRequestID,
                  quota: allowance
                    ? {
                        used: allowance.used,
                        reserved: allowance.reserved,
                        remaining: allowance.remaining,
                        resets: allowance.resets_at,
                      }
                    : 'not loaded',
                },
                null,
                2,
              )}
            </Text>
            <Button
              title="Refresh connection details"
              quiet
              disabled={busy}
              onPress={() => {
                void inspect(mode).catch(e => setError(friendly(e)));
              }}
            />
            <Button
              title="New conversation"
              quiet
              disabled={busy}
              onPress={() => {
                clearConversation();
                setSettings(false);
              }}
            />
            <Button
              title="Sign out"
              quiet
              disabled={busy}
              onPress={() => {
                void logout();
              }}
            />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <Button title="Done" onPress={() => setSettings(false)} />
            <Text style={styles.footer}>
              Unreleased shared-native development build. No provider key or chat database.\nLangChain
              → Latchway → server-selected model.
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ChatApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0c1718' },
  body: { flex: 1 },
  header: {
    paddingHorizontal: 22,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: 2,
    color: '#77e6c5',
    fontWeight: '700',
  },
  title: { fontSize: 28, fontWeight: '700', color: '#f0f7f4', marginTop: 5 },
  trustRow: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 7, height: 7, backgroundColor: '#829791', borderRadius: 4 },
  verified: { backgroundColor: '#77e6c5' },
  muted: { fontSize: 12, color: '#a6b9b3' },
  proof: {
    fontSize: 11,
    color: '#d5c984',
    paddingHorizontal: 22,
    marginBottom: 8,
  },
  auth: { flex: 1, padding: 24, justifyContent: 'center' },
  hero: {
    fontSize: 32,
    lineHeight: 39,
    fontWeight: '600',
    color: '#eff8f3',
    marginBottom: 16,
  },
  description: {
    fontSize: 15,
    lineHeight: 23,
    color: '#b3c6c0',
    marginBottom: 24,
  },
  label: {
    color: '#b3c6c0',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 18,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#192b2c',
    borderWidth: 1,
    borderColor: '#314544',
    color: '#f0f7f4',
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#77e6c5',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 13,
    alignItems: 'center',
    marginVertical: 5,
  },
  buttonText: { color: '#0c2520', fontSize: 14, fontWeight: '700' },
  quiet: { backgroundColor: '#1c302f' },
  quietText: { color: '#a7e9d5' },
  disabled: { opacity: 0.45 },
  modeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#223736',
  },
  mode: {
    color: '#86c6b5',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  messages: { flex: 1 },
  messagesContent: { padding: 16, paddingBottom: 28 },
  welcome: { paddingVertical: 28, paddingHorizontal: 6 },
  bubble: {
    backgroundColor: '#17282a',
    borderRadius: 18,
    padding: 17,
    marginBottom: 16,
    marginRight: 18,
  },
  userBubble: { backgroundColor: '#244d44', marginRight: 0, marginLeft: 32 },
  bubbleLabel: {
    fontSize: 9,
    letterSpacing: 1.5,
    color: '#97c6b7',
    marginBottom: 8,
  },
  messageText: { fontSize: 16, lineHeight: 25, color: '#ebf4ef' },
  spinner: { alignSelf: 'flex-start', marginTop: 12 },
  tool: {
    borderLeftWidth: 2,
    borderLeftColor: '#77e6c5',
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#142622',
  },
  toolTitle: { fontSize: 13, color: '#b6e4d5', marginBottom: 5 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
  },
  messageInput: { flex: 1, maxHeight: 120, marginBottom: 0 },
  footer: {
    textAlign: 'center',
    color: '#829791',
    fontSize: 10,
    lineHeight: 17,
    marginVertical: 12,
    paddingHorizontal: 12,
  },
  error: {
    color: '#ffb6a9',
    fontSize: 13,
    lineHeight: 21,
    paddingVertical: 12,
  },
  sheet: { padding: 24 },
  code: {
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
    color: '#b3dbcc',
    padding: 16,
    backgroundColor: '#152626',
    borderRadius: 12,
  },
});
