import React, {useEffect, useRef, useState} from 'react';
import {Button, ScrollView, Text, TextInput, View} from 'react-native';
import {Latchway, type LatchwayClient} from '@latchway/react-native';
import type {BaseMessage} from '@langchain/core/messages';
import {langchainTurn} from './src/chat';

/** Native owns Firebase, configuration, login and logout. This is only a surface. */
export default function EmbeddedChat() {
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState('Check Singapore weather and explain how Latchway protects this request.');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = useRef<LatchwayClient | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const epoch = useRef(0);
  const history = useRef<BaseMessage[]>([]);
  useEffect(() => {
    const observation = new AbortController();
    void (async () => {
      const app = await Latchway.getApp('latchway-chat');
      let generation: string | undefined;
      for await (const snapshot of app.states(observation.signal)) {
        if (observation.signal.aborted) break;
        if (snapshot.generationID !== generation || snapshot.state !== 'active') {
          epoch.current++;
          controller.current?.abort();
          await client.current?.dispose();
          client.current = undefined;
          history.current = [];
          setText('');
          setBusy(false);
        }
        generation = snapshot.generationID;
        if (snapshot.state === 'active' && !client.current) {
          const attachingEpoch = epoch.current;
          const attached = await app.makeClient();
          if (observation.signal.aborted || epoch.current !== attachingEpoch) {
            await attached.dispose();
            break;
          }
          client.current = attached;
        }
        if (observation.signal.aborted) break;
        setEnabled(snapshot.state === 'active');
      }
    })().catch(() => { if (!observation.signal.aborted) setText('Return to the native host to sign in or finish cleanup.'); });
    return () => {
      epoch.current++;
      observation.abort();
      controller.current?.abort();
      void client.current?.dispose();
      client.current = undefined;
    };
  }, []);

  async function send() {
    const captured = client.current;
    if (!captured || busy) return;
    const version = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const result = await langchainTurn(captured, history.current, prompt, abort.signal,
        answer => { if (epoch.current === version) setText(answer); }, () => {});
      if (epoch.current === version) history.current = [...history.current.slice(-8), ...result.messages];
    } catch {
      if (epoch.current === version) setText('Request stopped or failed. No automatic retry was sent.');
    } finally { if (epoch.current === version) setBusy(false); }
  }
  return <View style={{flex: 1, padding: 24, backgroundColor: '#ffffff'}}>
    <Text style={{fontSize: 22, color: '#12352c'}}>Embedded React Native + LangChain</Text>
    <Text style={{color: '#12352c'}}>Native owns sign-in. Closing this screen only disposes this client.</Text>
    <TextInput accessibilityLabel="Chat prompt" value={prompt} onChangeText={setPrompt}
      style={{borderWidth: 1, padding: 12, marginVertical: 16, color: '#12352c'}} multiline />
    <Button title={busy ? 'Sending…' : 'Send from React Native'} disabled={!enabled || busy} onPress={() => { void send(); }} />
    <Button title="Stop" disabled={!busy} onPress={() => controller.current?.abort()} />
    <ScrollView><Text selectable style={{fontSize: 16, lineHeight: 24, color: '#12352c'}}>{text}</Text></ScrollView>
  </View>;
}
