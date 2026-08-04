import { useCallback, useEffect, useRef, useState } from 'react';
import * as idb from '../utils/idb';
import {
  MIGRATE_CHANNEL,
  DEFAULT_SOURCE_ORIGIN,
  asMigrateMsg,
  isAllowedOrigin,
  collectInventory,
  readLsSnapshot,
  applyLsSnapshot,
  readExistingIdbKeys,
  formatBytes,
  type Inventory,
  type LsSnapshot,
  type MergeCounts,
  type ReceiverMsg,
  type SourceMsg,
} from '../utils/migrate';
import { PillButton, PillInput, Card, surfaceClass } from './components';

/**
 * `/migrate` — moves authoring data between two origins of the same deployment.
 *
 * Two roles share the route:
 *   - `/migrate`            receiver. Runs on the origin you are moving *to*.
 *   - `/migrate?source=1`   source. Opened as a popup by the receiver, on the
 *                           origin you are moving *from*. Never opened by hand.
 *
 * See `utils/migrate.ts` for why this is a popup rather than an iframe.
 */
export function MigrateScreen() {
  const isSource = new URLSearchParams(window.location.search).get('source') === '1';
  return isSource ? <SourceRole /> : <ReceiverRole />;
}

/* ════════════════════════════════════════════════════════════════════════════
   Source — the old origin. Reads its own jar and streams it to the opener.
   ════════════════════════════════════════════════════════════════════════════ */

const NO_OPENER_MESSAGE =
  'この画面は移行先サイトの「/migrate」から自動で開かれます。直接開いても何もできません。';

function SourceRole() {
  // `window.opener` is fixed for the lifetime of the window, so the "opened by
  // hand" case is initial state rather than something an effect discovers.
  const [opener] = useState<Window | null>(() => window.opener as Window | null);
  const [status, setStatus] = useState<'waiting' | 'sending' | 'done' | 'error'>(
    opener ? 'waiting' : 'error',
  );
  const [detail, setDetail] = useState(
    opener ? '移行先のタブからの接続を待っています…' : NO_OPENER_MESSAGE,
  );
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const ackWaiters = useRef(new Map<number, () => void>());
  const started = useRef(false);

  useEffect(() => {
    if (!opener) return;

    const send = (msg: SourceMsg, origin: string) => opener.postMessage(msg, origin);

    const waitAck = (index: number) =>
      new Promise<void>((resolve) => ackWaiters.current.set(index, resolve));

    const run = async (parentOrigin: string, includeApiKeys: boolean) => {
      setStatus('sending');
      setDetail('保存内容を調べています…');
      const inventory: Inventory = await collectInventory();
      const ls: LsSnapshot = readLsSnapshot(includeApiKeys);
      const total = inventory.manifestKeys.length + inventory.blobKeys.length;
      setProgress({ sent: 0, total });
      setDetail(
        `シーン ${inventory.manifestKeys.length} 件 / ファイル ${inventory.blobKeys.length} 件` +
          ` (${formatBytes(inventory.blobBytes)}) を送信します`,
      );

      let index = 0;
      send({ ch: MIGRATE_CHANNEL, type: 'inventory', ls, ...inventory }, parentOrigin);
      await waitAck(index++);

      for (const key of inventory.manifestKeys) {
        const value = await idb.loadManifest(key).catch(() => null);
        send({ ch: MIGRATE_CHANNEL, type: 'manifest', key, value, index }, parentOrigin);
        await waitAck(index++);
        setProgress((p) => ({ ...p, sent: p.sent + 1 }));
      }

      for (const key of inventory.blobKeys) {
        const blob = await idb.loadBlob(key).catch(() => null);
        if (blob) {
          send({ ch: MIGRATE_CHANNEL, type: 'blob', key, blob, index }, parentOrigin);
          await waitAck(index++);
        }
        setProgress((p) => ({ ...p, sent: p.sent + 1 }));
      }

      send({ ch: MIGRATE_CHANNEL, type: 'done' }, parentOrigin);
      setStatus('done');
      setDetail('送信が完了しました。このタブは閉じて構いません。');
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== opener || !isAllowedOrigin(e.origin)) return;
      const msg = asMigrateMsg<ReceiverMsg>(e.data);
      if (!msg) return;

      if (msg.type === 'start') {
        if (started.current) return;
        started.current = true;
        run(e.origin, msg.includeApiKeys).catch((err: unknown) => {
          setStatus('error');
          setDetail(err instanceof Error ? err.message : String(err));
          send({ ch: MIGRATE_CHANNEL, type: 'error', message: String(err) }, e.origin);
        });
      } else if (msg.type === 'ack') {
        ackWaiters.current.get(msg.index)?.();
        ackWaiters.current.delete(msg.index);
      } else if (msg.type === 'bye') {
        window.close();
      }
    };

    window.addEventListener('message', onMessage);

    // The opener attaches its listener before `window.open`, but announce on a
    // repeat anyway — a slow first paint here should not strand the handshake.
    const ping = window.setInterval(() => {
      if (started.current) { window.clearInterval(ping); return; }
      opener.postMessage({ ch: MIGRATE_CHANNEL, type: 'ready' } satisfies SourceMsg, '*');
    }, 400);
    opener.postMessage({ ch: MIGRATE_CHANNEL, type: 'ready' } satisfies SourceMsg, '*');

    return () => {
      window.clearInterval(ping);
      window.removeEventListener('message', onMessage);
    };
  }, [opener]);

  const pct = progress.total ? Math.round((progress.sent / progress.total) * 100) : 0;

  return (
    <Screen>
      <Card tone="surface" style={{ padding: '28px 26px' }}>
        <div className="ds-title" style={{ marginBottom: 4 }}>移行元 — データ送信</div>
        <div className="ds-sub" style={{ marginBottom: 18 }}>{window.location.origin}</div>
        <div className="ds-body" style={{ marginBottom: 16 }}>{detail}</div>
        {status === 'sending' && (
          <>
            <div className="ds-progress" style={{ width: '100%' }}>
              <div className="ds-progress__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="ds-hint" style={{ marginTop: 8 }}>
              {progress.sent} / {progress.total} 件
            </div>
          </>
        )}
        {status === 'error' && (
          <div className={`${surfaceClass('danger')} ds-pill`} style={{ display: 'block', textAlign: 'center' }}>
            接続できません
          </div>
        )}
      </Card>
    </Screen>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Receiver — the new origin. Opens the source and writes what comes back.
   ════════════════════════════════════════════════════════════════════════════ */

interface Summary {
  manifestsWritten: number;
  manifestsSkipped: number;
  blobsWritten: number;
  blobsSkipped: number;
  bytes: number;
  lists: Record<string, MergeCounts>;
  scalarsWritten: string[];
}

function ReceiverRole() {
  const [sourceOrigin, setSourceOrigin] = useState(DEFAULT_SOURCE_ORIGIN);
  const [overwrite, setOverwrite] = useState(false);
  const [includeApiKeys, setIncludeApiKeys] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0, bytes: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);

  const popupRef = useRef<Window | null>(null);
  const tally = useRef<Summary>(blankSummary());
  const pendingLs = useRef<LsSnapshot>({});
  const existing = useRef<{ manifests: Set<string>; blobs: Set<string> }>({
    manifests: new Set(),
    blobs: new Set(),
  });

  const finish = useCallback((snapshot: LsSnapshot) => {
    const applied = applyLsSnapshot(snapshot, overwrite);
    const result: Summary = { ...tally.current, lists: applied.lists, scalarsWritten: applied.scalarsWritten };
    setSummary(result);
    setPhase('done');
    setDetail('移行が完了しました。プロジェクト一覧を開いて確認してください。');
  }, [overwrite]);

  const start = useCallback(async () => {
    const origin = sourceOrigin.trim().replace(/\/+$/, '');
    if (!isAllowedOrigin(origin)) {
      setPhase('error');
      setDetail(`このオリジンは許可リストにありません: ${origin}`);
      return;
    }
    if (origin === window.location.origin) {
      setPhase('error');
      setDetail('移行元と移行先が同じオリジンです。移行先のサイトでこの画面を開いてください。');
      return;
    }

    tally.current = blankSummary();
    pendingLs.current = {};
    existing.current = await readExistingIdbKeys();
    setSummary(null);
    setProgress({ done: 0, total: 0, bytes: 0 });
    setPhase('running');
    setDetail('移行元のタブを開いています…');

    const popup = window.open(`${origin}/migrate?source=1`, 'migrate-source', 'width=520,height=560');
    if (!popup) {
      setPhase('error');
      setDetail('ポップアップがブロックされました。このサイトのポップアップを許可してから、もう一度お試しください。');
      return;
    }
    popupRef.current = popup;
  }, [sourceOrigin]);

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const popup = popupRef.current;
      if (!popup || e.source !== popup) return;
      if (e.origin !== sourceOrigin.trim().replace(/\/+$/, '')) return;
      const msg = asMigrateMsg<SourceMsg>(e.data);
      if (!msg) return;

      const reply = (m: ReceiverMsg) => popup.postMessage(m, e.origin);

      switch (msg.type) {
        case 'ready':
          reply({ ch: MIGRATE_CHANNEL, type: 'start', includeApiKeys });
          setDetail('移行元と接続しました。保存内容を確認しています…');
          break;

        case 'inventory': {
          pendingLs.current = msg.ls;
          const total = msg.manifestKeys.length + msg.blobKeys.length;
          setProgress({ done: 0, total, bytes: 0 });
          setDetail(
            `シーン ${msg.manifestKeys.length} 件 / ファイル ${msg.blobKeys.length} 件` +
              ` (${formatBytes(msg.blobBytes)}) を受け取ります`,
          );
          reply({ ch: MIGRATE_CHANNEL, type: 'ack', index: 0 }); // inventory is always index 0
          break;
        }

        case 'manifest': {
          const exists = existing.current.manifests.has(msg.key);
          if (!exists || overwrite) {
            if (msg.value !== null) {
              await idb.saveManifest(msg.key, msg.value).catch(() => undefined);
              tally.current.manifestsWritten++;
            }
          } else {
            tally.current.manifestsSkipped++;
          }
          setProgress((p) => ({ ...p, done: p.done + 1 }));
          reply({ ch: MIGRATE_CHANNEL, type: 'ack', index: msg.index });
          break;
        }

        case 'blob': {
          const exists = existing.current.blobs.has(msg.key);
          if (!exists || overwrite) {
            await idb.saveBlob(msg.key, msg.blob).catch(() => undefined);
            tally.current.blobsWritten++;
            tally.current.bytes += msg.blob.size;
          } else {
            tally.current.blobsSkipped++;
          }
          setProgress((p) => ({ ...p, done: p.done + 1, bytes: tally.current.bytes }));
          reply({ ch: MIGRATE_CHANNEL, type: 'ack', index: msg.index });
          break;
        }

        case 'done':
          finish(pendingLs.current);
          reply({ ch: MIGRATE_CHANNEL, type: 'bye' });
          popupRef.current = null;
          break;

        case 'error':
          setPhase('error');
          setDetail(`移行元でエラーが発生しました: ${msg.message}`);
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sourceOrigin, includeApiKeys, overwrite, finish]);

  // A popup closed mid-transfer would otherwise leave the UI spinning forever.
  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => {
      if (popupRef.current?.closed) {
        popupRef.current = null;
        setPhase('error');
        setDetail('移行元のタブが閉じられたため中断しました。書き込み済みのデータはそのまま残っています。');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const busy = phase === 'running';

  return (
    <Screen>
      <Card tone="surface" style={{ padding: '32px 28px' }}>
        <div className="ds-title" style={{ marginBottom: 4 }}>プロジェクトデータの移行</div>
        <div className="ds-sub" style={{ marginBottom: 20 }}>
          旧サイトのブラウザ保存データを、このサイト ({window.location.origin}) に取り込みます。
        </div>

        <div className="ds-label" style={{ marginBottom: 6 }}>移行元のオリジン</div>
        <PillInput
          type="text"
          value={sourceOrigin}
          onChange={(e) => setSourceOrigin(e.target.value)}
          disabled={busy}
        />

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Check checked={overwrite} disabled={busy} onChange={setOverwrite}>
            同じ ID のデータは移行元で上書きする
          </Check>
          <Check checked={includeApiKeys} disabled={busy} onChange={setIncludeApiKeys}>
            API キーと選択中のモデルも移行する
          </Check>
        </div>

        <div style={{ marginTop: 22, display: 'flex' }}>
          <PillButton variant="accent" fullWidth disabled={busy} onClick={() => { void start(); }}>
            {busy ? '移行中…' : '移行を開始'}
          </PillButton>
        </div>

        {detail && (
          <div className="ds-body" style={{ marginTop: 18 }}>{detail}</div>
        )}

        {busy && progress.total > 0 && (
          <>
            <div className="ds-progress" style={{ width: '100%', marginTop: 12 }}>
              <div className="ds-progress__fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="ds-hint" style={{ marginTop: 8 }}>
              {progress.done} / {progress.total} 件 · {formatBytes(progress.bytes)}
            </div>
          </>
        )}

        {phase === 'error' && (
          <div className={`${surfaceClass('danger')} ds-pill`} style={{ marginTop: 14, display: 'block', textAlign: 'center' }}>
            中断しました
          </div>
        )}

        {summary && <SummaryBlock summary={summary} />}

        <div className="ds-hint" style={{ marginTop: 18 }}>
          移行元のタブはポップアップで開きます。ブロックされた場合は許可してください。
        </div>
      </Card>
    </Screen>
  );
}

function SummaryBlock({ summary }: { summary: Summary }) {
  const projects = summary.lists['3droomtour:projects:v1'];
  const clips = summary.lists['3droomtour:video-clips:v1'];
  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="ds-label">取り込み結果</div>
      {projects && (
        <Row label="プロジェクト">
          追加 {projects.added} · 上書き {projects.overwritten} · 既存のまま {projects.kept}
        </Row>
      )}
      <Row label="シーン定義">
        書き込み {summary.manifestsWritten} · スキップ {summary.manifestsSkipped}
      </Row>
      <Row label="ファイル">
        書き込み {summary.blobsWritten} · スキップ {summary.blobsSkipped} · {formatBytes(summary.bytes)}
      </Row>
      {clips && (
        <Row label="動画クリップ">
          追加 {clips.added} · 上書き {clips.overwritten} · 既存のまま {clips.kept}
        </Row>
      )}
      {summary.scalarsWritten.length > 0 && (
        <Row label="設定">{summary.scalarsWritten.length} 件</Row>
      )}
      <div style={{ marginTop: 14, display: 'flex' }}>
        <PillButton variant="neutral" fullWidth onClick={() => { window.location.href = '/'; }}>
          プロジェクト一覧を開く
        </PillButton>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <div className="ds-hint" style={{ minWidth: 92 }}>{label}</div>
      <div className="ds-body">{children}</div>
    </div>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer' }}>
      <input
        className="ds-check"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ds-body">{children}</span>
    </label>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="ds-screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 460, maxWidth: 'calc(100vw - 32px)' }}>{children}</div>
    </div>
  );
}

function blankSummary(): Summary {
  return {
    manifestsWritten: 0,
    manifestsSkipped: 0,
    blobsWritten: 0,
    blobsSkipped: 0,
    bytes: 0,
    lists: {},
    scalarsWritten: [],
  };
}
