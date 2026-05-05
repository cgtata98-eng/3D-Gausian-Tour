import { useState } from 'react';
import { verifyCredentials, markAuthenticated, isAuthenticated } from '../utils/auth';

/**
 * Wraps admin / debug routes. If not authenticated, renders a centred login
 * form instead of the children. Public viewer routes don't go through this.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => isAuthenticated());
  if (authed) return <>{children}</>;
  return <LoginForm onSuccess={() => setAuthed(true)} />;
}

function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    // Tiny delay so a wrong password doesn't reveal "no network call happened"
    // (and prevents an accidental form-resubmit storm).
    setTimeout(() => {
      if (verifyCredentials(username.trim(), password)) {
        markAuthenticated();
        onSuccess();
      } else {
        setError('ID またはパスワードが違います');
        setSubmitting(false);
      }
    }, 200);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f7f8fa 0%, #e8ebf0 100%)',
        fontFamily: 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 360,
          maxWidth: 'calc(100vw - 32px)',
          padding: '32px 28px',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 12px 32px rgba(15,23,42,0.12), 0 2px 6px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', marginBottom: 4 }}>
          管理画面ログイン
        </div>
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.55)', marginBottom: 20 }}>
          顧客向けビューアは下記なしでご覧いただけます。
        </div>

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
          ID
        </label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          autoComplete="username"
          disabled={submitting}
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginTop: 12, marginBottom: 4 }}>
          パスワード
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={submitting}
          style={inputStyle}
        />

        {error && (
          <div style={{ marginTop: 12, padding: '8px 10px', fontSize: 11.5, color: '#991b1b', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !username.trim() || !password}
          style={{
            width: '100%',
            marginTop: 18,
            padding: '10px 14px',
            fontSize: 13,
            fontWeight: 700,
            color: '#fff',
            background: submitting ? '#94a3b8' : '#1d4ed8',
            border: 'none',
            borderRadius: 8,
            cursor: submitting || !username.trim() || !password ? 'not-allowed' : 'pointer',
            opacity: submitting || !username.trim() || !password ? 0.6 : 1,
            transition: 'background 100ms',
          }}
        >
          {submitting ? '確認中…' : 'ログイン'}
        </button>

        <div style={{ marginTop: 14, fontSize: 10.5, color: 'rgba(0,0,0,0.45)', lineHeight: 1.5 }}>
          7 日間ログイン状態が保持されます。
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  border: '1px solid #d1d5db',
  borderRadius: 6,
  outline: 'none',
  fontFamily: 'inherit',
  background: '#fff',
  boxSizing: 'border-box',
};
