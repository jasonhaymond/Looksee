// The sign-in screen: server address, email and password, then the second
// factor (authenticator code, a recovery code, and the emailed code when the
// server asks for one from a new address). On a first-ever sign-in it walks
// through setting up an authenticator app and shows the recovery codes once.
//
// Two-factor sign-in is mandatory in Looksee; this screen has no way around
// it. Passkeys aren't offered here; the authenticator code always works.

import { useState } from "react";
import { KeyboardAvoidingView, Linking, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/theme";
import { errorText } from "../lib/format";
import type { LoginStep } from "../lib/shared";
import { Button, ButtonRow, Card, ErrorBox, Field, Note, Screen, T } from "../components/ui";

export default function SignIn() {
  const session = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState(session.serverUrl ?? "");
  const [email, setEmail] = useState(session.email ?? "");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<LoginStep | null>(null);
  const [code, setCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Recovery codes from a first-time setup, shown once before continuing.
  const [codes, setCodes] = useState<string[] | null>(null);
  const [finish, setFinish] = useState<(() => void) | null>(null);

  /** Step 1: checks the server and the password. */
  async function submitPassword() {
    setBusy(true);
    setError(null);
    try {
      setStep(await session.startSignIn(server, email.trim(), password));
      setPassword("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /** Step 2: the second factor. */
  async function submitCode() {
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const input = { challengeId: step.challengeId, ...(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }), ...(step.emailCode ? { emailCode: emailCode.trim() } : {}) };
      const result = await session.finishSignIn(input);
      if (result.recoveryCodes?.length) {
        setFinish(() => result.complete);
        setCodes(result.recoveryCodes);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <Screen>
        <View style={{ height: insets.top }} />
        <Card title="Save your recovery codes">
          <T>Each code signs you in once if you lose your authenticator app. They are shown only now and can't be shown again; you can make new ones on the Security screen.</T>
          <T selectable style={{ fontFamily: "monospace", fontSize: 16, lineHeight: 26 }}>{codes.join("\n")}</T>
          <ButtonRow>
            <Button title="Copy" icon="copy-outline" onPress={() => void Clipboard.setStringAsync(codes.join("\n"))} />
            <Button title="I've saved them in my password manager" variant="primary" onPress={() => { setCodes(null); finish?.(); }} />
          </ButtonRow>
        </Card>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView behavior="height" style={{ flex: 1, backgroundColor: colors.bg }}>
      <Screen>
        <View style={{ height: insets.top + 24 }} />
        <View style={{ alignItems: "center", gap: 6, marginBottom: 8 }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 7, borderColor: colors.accent, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent }} />
          </View>
          <T bold size="xl">Looksee</T>
        </View>
        {session.notice ? <Note tone="warn">{session.notice}</Note> : null}
        {!step ? (
          <Card>
            <Field label="Server address" value={server} onChangeText={setServer} placeholder="looksee.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" help="The address you open the Looksee dashboard at." />
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" onSubmitEditing={submitPassword} />
            <ErrorBox error={error} />
            <Button title="Continue" variant="primary" busy={busy} disabled={!server || !email || !password} onPress={submitPassword} />
          </Card>
        ) : (
          <Card>
            {step.step === "enroll" ? (
              <>
                <T bold>Set up two-factor sign-in</T>
                <T>Add Looksee to an authenticator app (Aegis, 2FAS, Google Authenticator, a password manager…), then enter the 6-digit code it shows.</T>
                <T selectable style={{ fontFamily: "monospace" }}>{step.enroll?.secret.replace(/(.{4})/g, "$1 ").trim()}</T>
                <ButtonRow>
                  <Button small title="Open in authenticator app" onPress={() => step.enroll && void Linking.openURL(step.enroll.uri).catch(() => setError("No authenticator app on this phone handles the link. Type the key above into it instead."))} />
                  <Button small title="Copy key" onPress={() => step.enroll && void Clipboard.setStringAsync(step.enroll.secret)} />
                </ButtonRow>
              </>
            ) : (
              <T>{useRecovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app."}</T>
            )}
            <Field label={useRecovery ? "Recovery code" : "Code"} value={code} onChangeText={setCode} keyboardType={useRecovery ? "default" : "number-pad"} autoComplete="one-time-code" autoCapitalize="none" onSubmitEditing={submitCode} />
            {step.emailCode ? <Field label="Code from the email we just sent" value={emailCode} onChangeText={setEmailCode} keyboardType="number-pad" help="Asked because this is a new address for your account." /> : null}
            <ErrorBox error={error} />
            <Button title="Sign in" variant="primary" busy={busy} disabled={!code || (step.emailCode && !emailCode)} onPress={submitCode} />
            <ButtonRow>
              {step.step === "totp" ? <Button small title={useRecovery ? "Use authenticator code" : "Use a recovery code"} onPress={() => { setUseRecovery(!useRecovery); setCode(""); }} /> : null}
              <Button small title="Start again" onPress={() => { setStep(null); setCode(""); setError(null); }} />
            </ButtonRow>
          </Card>
        )}
        <T size="s" muted style={{ textAlign: "center" }}>After signing in, this phone also receives Looksee alerts sent to "Notifications" channels.</T>
      </Screen>
    </KeyboardAvoidingView>
  );
}
