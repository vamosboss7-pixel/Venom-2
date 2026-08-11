import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Copy,
  Gift,
  Gamepad2,
  Grid3X3,
  MoreVertical,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Timer,
  Trophy,
  Volume2,
  VolumeX,
  Wallet,
  X,
} from 'lucide-react';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready?: () => void;
        expand?: () => void;
        close?: () => void;
        colorScheme?: 'light' | 'dark';
        themeParams?: { bg_color?: string; secondary_bg_color?: string; text_color?: string; button_color?: string };
        initData?: string;
        initDataUnsafe?: { user?: { id?: number; first_name?: string; last_name?: string; username?: string; photo_url?: string } };
      };
    };
  }
}

const queryClient = new QueryClient();
const MAX_CARDS = 4;
const TOTAL_NUMBERS = 150;
const STAKE = 4;
const START_COUNTDOWN = 50;
const GAME_ID = '#86195';
const CALL_INTERVAL = 3000;

type Cell = number | 'star';
type Tab = 'bingo' | 'wallet';
type Profile = {
  firstName?: string;
  lastName?: string | null;
  playWalletBalance?: string;
  winWalletBalance?: string;
};

function buildCard(id: number): Cell[] {
  let seed = id * 9301 + 49297;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const columns: number[][] = [];
  for (let column = 0; column < 5; column += 1) {
    const pool = Array.from({ length: 15 }, (_, index) => column * 15 + index + 1);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    columns.push(pool.slice(0, 5));
  }
  return Array.from({ length: 25 }, (_, index) => {
    if (index === 12) return 'star';
    const row = Math.floor(index / 5);
    const column = index % 5;
    return columns[column][row];
  });
}

function useTelegramBridge() {
  const [userName, setUserName] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isTelegram, setIsTelegram] = useState(false);
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;

    webApp.ready?.();
    webApp.expand?.();
    setIsTelegram(true);
    const user = webApp.initDataUnsafe?.user;
    if (user?.first_name) setUserName([user.first_name, user.last_name].filter(Boolean).join(' '));
    const theme = webApp.themeParams;
    if (theme?.bg_color) document.documentElement.style.setProperty('--telegram-bg', theme.bg_color);
    if (theme?.secondary_bg_color) document.documentElement.style.setProperty('--telegram-secondary-bg', theme.secondary_bg_color);
    if (theme?.button_color) document.documentElement.style.setProperty('--telegram-button', theme.button_color);
    if (theme?.text_color) document.documentElement.style.setProperty('--telegram-text', theme.text_color);

    if (!webApp.initData) return;
    const configuredApiUrl = import.meta.env.VITE_API_BASE_URL;
    const apiUrl = configuredApiUrl
      ? (configuredApiUrl.startsWith('http') ? configuredApiUrl : `https://${configuredApiUrl}`)
      : '';
    void fetch(`${apiUrl}/api/telegram/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: webApp.initData }),
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { user?: { first_name?: string; last_name?: string }; profile?: Profile };
      if (data.user?.first_name) setUserName([data.user.first_name, data.user.last_name].filter(Boolean).join(' '));
      if (data.profile) {
        setProfile(data.profile);
        if (data.profile.firstName) setUserName([data.profile.firstName, data.profile.lastName].filter(Boolean).join(' '));
      }
    }).catch(() => undefined);
  }, []);
  return { userName, profile, isTelegram };
}

function Header() {
  const { userName, isTelegram } = useTelegramBridge();
  const [location, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => {
    if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close();
    else setMenuOpen(false);
  };
  return (
    <header className="glass-chrome depth-surface sticky top-0 z-40 flex shrink-0 items-center gap-3 border-b px-4 py-3 text-[hsl(var(--foreground))]">
      <button type="button" data-testid="button-close-app" aria-label="ዝጋ" onClick={close} className="rounded-xl p-1.5 transition-transform active:scale-90 hover:bg-white/10">
        <X className="h-6 w-6" />
      </button>
      <button type="button" data-testid="button-brand-home" onClick={() => setLocation('/')} className="flex flex-1 items-center gap-2 text-left">
        <span className="text-shimmer text-[22px] font-extrabold tracking-tight">Venom Bingo</span>
        <span className="text-2xl leading-none">⚡</span>
      </button>
      <button type="button" data-testid="button-header-dropdown" aria-label="አማራጮች" onClick={() => setMenuOpen((open) => !open)} className="rounded-xl p-1.5 transition-transform active:scale-90 hover:bg-white/10">
        <ChevronDown className="h-7 w-7" />
      </button>
      <button type="button" data-testid="button-header-menu" aria-label="ምናሌ" onClick={() => setMenuOpen((open) => !open)} className="rounded-xl p-1.5 transition-transform active:scale-90 hover:bg-white/10">
        <MoreVertical className="h-6 w-6" />
      </button>
      {menuOpen && (
        <div className="absolute right-3 top-14 z-30 w-48 overflow-hidden rounded-2xl border border-white/10 bg-[hsl(161_35%_15%)] p-1.5 shadow-2xl animate-rise-in">
          <button type="button" data-testid="button-header-help" onClick={() => setMenuOpen(false)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/10">
            <CircleHelp className="h-4 w-4 text-[hsl(var(--primary))]" /> እገዛ እና ህጎች
          </button>
          <div className="px-3 pb-2 pt-1 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{isTelegram ? userName : 'Telegram only'}</div>
        </div>
      )}
    </header>
  );
}

function BottomNav({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="glass-chrome depth-surface sticky bottom-0 z-40 grid shrink-0 grid-cols-2 border-t px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
      {(['bingo', 'wallet'] as Tab[]).map((tab) => {
        const selected = active === tab;
        return (
          <button
            type="button"
            key={tab}
            data-testid={`button-tab-${tab}`}
            onClick={() => onChange(tab)}
            className={`relative flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-bold tracking-[.12em] transition-all duration-200 active:scale-95 ${selected ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`}
          >
            {selected && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-[hsl(var(--primary))] shadow-[0_0_14px_hsl(var(--primary)/.8)]" />}
            {tab === 'bingo' ? <Grid3X3 className="h-5 w-5" /> : <Wallet className="h-5 w-5" />}
            {tab === 'bingo' ? 'BINGO' : 'WALLET'}
          </button>
        );
      })}
    </nav>
  );
}

function Stats({ play, pot, cardsTaken, win = 0 }: { play: number; pot: number; cardsTaken: number; win?: number }) {
  const money = (amount: number) => amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="grid grid-cols-[.9fr_1.25fr_.9fr] gap-2.5 px-3 pt-3">
      <div className="depth-card rounded-2xl border border-white/10 bg-[hsl(161_35%_15%)] px-3 py-3">
        <div className="flex items-center gap-1 text-[10px] font-bold tracking-[.13em] text-[hsl(var(--muted-foreground))]"><Gamepad2 className="h-3.5 w-3.5 text-[hsl(var(--accent))]" /> PLAY</div>
        <div data-testid="text-play-stake" className="mt-1 font-mono text-lg font-bold">{money(play)}</div>
        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">ብር</div>
      </div>
      <div className="depth-card relative overflow-hidden rounded-2xl border border-[hsl(var(--primary)/.7)] bg-[hsl(161_35%_15%)] px-2 py-2.5 text-center shadow-[0_8px_28px_hsl(var(--primary)/.09)]">
        <span className="absolute -right-5 -top-7 h-16 w-16 rounded-full bg-[hsl(var(--primary)/.12)]" />
        <div className="relative text-[10px] font-bold uppercase tracking-[.1em] text-[hsl(var(--muted-foreground))]">ደራሹ</div>
        <div data-testid="text-pot" className="relative font-mono text-2xl font-bold text-[hsl(var(--primary))]">{money(pot)}</div>
        <div data-testid="text-cards-taken" className="relative text-[10px] text-[hsl(var(--foreground)/.72)]">የተያዙ ካርዶች: {cardsTaken}</div>
      </div>
      <div className="depth-card rounded-2xl border border-white/10 bg-[hsl(161_35%_15%)] px-3 py-3 text-right">
        <div className="flex items-center justify-end gap-1 text-[10px] font-bold tracking-[.13em] text-[hsl(var(--muted-foreground))]">WIN <Trophy className="h-3.5 w-3.5 text-[hsl(var(--primary))]" /></div>
        <div data-testid="text-win" className="mt-1 font-mono text-lg font-bold">{money(win)}</div>
        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">ብር</div>
      </div>
    </div>
  );
}

function SoundCountdown({ muted, onToggle, countdown }: { muted: boolean; onToggle: () => void; countdown: number }) {
  return (
    <section className="px-3 pt-4">
      <div className="flex items-center justify-between">
        <button type="button" data-testid="button-toggle-mute" onClick={onToggle} aria-pressed={muted} aria-label={muted ? 'ድምፅ አብራ' : 'ድምፅ ዝጋ'} className={`depth-action grid h-11 w-11 place-items-center rounded-2xl border transition-all active:scale-90 ${muted ? 'border-[hsl(var(--destructive)/.55)] bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]' : 'border-[hsl(var(--accent)/.55)] bg-[hsl(var(--accent)/.1)] text-[hsl(var(--accent))]'}`}>
          {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        </button>
        <div className="text-center">
          <div className="text-[11px] font-bold tracking-[.32em] text-[hsl(var(--muted-foreground))]">VENOM <span className="text-[hsl(var(--primary))]">•</span> BINGO</div>
          <div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">ቀጣዩ ዙር በቅርቡ</div>
        </div>
        <div data-testid="status-countdown" aria-label={`ቀሪ ጊዜ ${countdown} ሰከንድ`} className={`timer-heartbeat depth-card relative grid h-12 w-12 place-items-center rounded-2xl border-2 border-[hsl(var(--primary))] font-mono text-base font-bold text-[hsl(var(--primary))] ${countdown <= 10 ? 'timer-critical' : ''}`}>
          <span className="absolute inset-0 rounded-2xl border border-[hsl(var(--primary)/.3)] animate-pulse-ring" />
          <span className="relative">{countdown}</span>
        </div>
      </div>
      <div className="mt-3 h-px bg-white/10" />
    </section>
  );
}

function MiniCard({ id, grid }: { id: number; grid: Cell[] }) {
  return (
    <div className="depth-card w-[76px] shrink-0 rounded-xl border border-[hsl(var(--primary)/.55)] bg-[hsl(161_35%_15%/.96)] p-1.5 shadow-lg">
      <div className="mb-1 flex items-center justify-between px-0.5 text-[9px] font-bold text-[hsl(var(--primary))]"><span>#{id}</span><span>LIVE</span></div>
      <div className="grid grid-cols-5 gap-0.5">{grid.map((cell, index) => <div key={`${id}-${index}`} className={`grid aspect-square place-items-center rounded-[3px] text-[8px] font-bold ${cell === 'star' ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'bg-[hsl(159_22%_22%)] text-[hsl(var(--foreground)/.8)]'}`}>{cell === 'star' ? '✦' : cell}</div>)}</div>
    </div>
  );
}

function NumberGrid({ selected, taken, onToggle }: { selected: Set<number>; taken: Set<number>; onToggle: (number: number) => void }) {
  return (
    <div className="px-3 pb-28 pt-4">
      <div className="mb-3 flex items-end justify-between">
        <div><h2 className="text-lg font-extrabold">ካርድ ይምረጡ</h2><p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">እስከ 4 ካርዶች · አንድ ካርድ 4 ብር</p></div>
        <div className="rounded-full bg-[hsl(var(--primary)/.12)] px-2.5 py-1 text-[11px] font-bold text-[hsl(var(--primary))]">{selected.size}/{MAX_CARDS}</div>
      </div>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
        {Array.from({ length: TOTAL_NUMBERS }, (_, index) => index + 1).map((number) => {
          const isSelected = selected.has(number);
          const isTaken = taken.has(number);
          return (
            <button type="button" key={number} data-testid={`button-card-${number}`} disabled={isTaken} onClick={() => onToggle(number)} className={`depth-action relative aspect-square rounded-xl border text-xs font-bold transition-all duration-150 active:scale-90 ${isSelected ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_4px_0_hsl(152_61%_30%)] -translate-y-0.5' : isTaken ? 'border-white/5 bg-white/[.025] text-[hsl(var(--muted-foreground)/.35)]' : 'border-white/10 bg-[hsl(161_35%_15%)] text-[hsl(var(--foreground)/.78)] hover:border-[hsl(var(--primary)/.7)] hover:bg-[hsl(var(--primary)/.1)]'}`}>
              {number}
              {isTaken && <span className="absolute inset-x-1.5 bottom-1 h-px rotate-[-28deg] bg-[hsl(var(--destructive)/.55)]" />}
              {isSelected && <span className="absolute right-1 top-0.5 text-[9px]">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function WalletPanel() {
  const { profile } = useTelegramBridge();
  const playWallet = profile?.playWalletBalance ?? '—';
  const winWallet = profile?.winWalletBalance ?? '—';

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-5 pt-5">
      <section className="depth-surface relative rounded-[32px] bg-[hsl(161_35%_15%)] p-6 shadow-[0_12px_35px_hsl(161_42%_4%/.24)]">
        <h2 className="text-shimmer text-xl font-extrabold tracking-[.04em]">YOUR BALANCES</h2>
        <div className="mt-5 grid grid-cols-2 gap-5">
          <div className="depth-card rounded-[26px] border border-[hsl(var(--foreground)/.8)] px-4 py-4">
            <div className="text-lg font-extrabold leading-tight">🎮 PLAY<br />WALLET</div>
            <div data-testid="text-play-wallet-balance" className="mt-3 font-mono text-2xl font-bold">{playWallet}</div>
          </div>
          <div className="depth-card rounded-[26px] border border-[hsl(var(--foreground)/.8)] px-4 py-4">
            <div className="text-lg font-extrabold leading-tight">🏆 WIN<br />WALLET</div>
            <div data-testid="text-win-wallet-balance" className="mt-3 font-mono text-2xl font-bold">{winWallet}</div>
          </div>
        </div>
      </section>
      <div className="mt-6 grid grid-cols-2 gap-5">
        <button type="button" data-testid="button-wallet-deposit" onClick={() => undefined} className="depth-action rounded-[24px] bg-[hsl(var(--accent))] px-3 py-4 text-sm font-extrabold text-[hsl(var(--accent-foreground))] shadow-[0_7px_0_hsl(152_61%_30%)] transition-transform active:translate-y-1 active:shadow-none">💳 DEPOSIT <span className="text-xs">(ገቢ)</span></button>
        <button type="button" data-testid="button-wallet-withdraw" onClick={() => undefined} className="depth-action rounded-[24px] bg-[hsl(var(--primary))] px-3 py-4 text-sm font-extrabold text-[hsl(var(--primary-foreground))] shadow-[0_7px_0_hsl(40_80%_33%)] transition-transform active:translate-y-1 active:shadow-none">💸 WITHDRAW <span className="text-xs">(ወጪ)</span></button>
      </div>
      <section className="depth-surface relative mt-7 min-h-28 rounded-[28px] bg-[hsl(161_35%_15%)] p-6">
        <h3 className="text-base font-extrabold tracking-[.04em]">RECENT HISTORY <span className="text-sm">(የቅርብ እንቅስቃሴዎች)</span></h3>
      </section>
    </div>
  );
}

function getApiUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL;
  return configured ? (configured.startsWith('http') ? configured : `https://${configured}`) : '';
}

function telegramHeaders(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData;
  return initData ? { 'x-telegram-init-data': initData } : {};
}

type RoundData = { id: number; calls: Array<{ number: number; position: number; calledAt: string }>; takenCardNumbers: number[] };
type ServerCard = { id?: number; cardNumber: number; grid: Cell[] };

function Home() {
  const [, setLocation] = useLocation();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [muted, setMuted] = useState(true);
  const [countdown, setCountdown] = useState(START_COUNTDOWN);
  const [tab, setTab] = useState<Tab>('bingo');
  const [showWarning, setShowWarning] = useState(false);
  const [round, setRound] = useState<RoundData | null>(null);
  const taken = useMemo(() => new Set(round?.takenCardNumbers ?? []), [round]);
  useEffect(() => { void fetch(`${getApiUrl()}/api/bingo/round`).then((response) => response.ok ? response.json() as Promise<RoundData> : null).then((data) => { if (data) setRound(data); }).catch(() => undefined); }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const timer = window.setInterval(() => setCountdown((current) => {
      if (current <= 1) {
        if (selectedRef.current.size > 0) {
          const cardNumbers = [...selectedRef.current].sort((a, b) => a - b);
          void fetch(`${getApiUrl()}/api/bingo/cards`, { method: 'POST', headers: { 'content-type': 'application/json', ...telegramHeaders() }, body: JSON.stringify({ cardNumbers }) })
            .then((response) => response.ok ? response.json() as Promise<{ roundId: number }> : null)
            .then((data) => { if (data) setLocation(`/play?round=${data.roundId}`); })
            .catch(() => undefined);
          return 0;
        }
        return START_COUNTDOWN;
      }
      return current - 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [setLocation]);
  const toggle = (number: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(number)) next.delete(number);
      else if (next.size < MAX_CARDS) next.add(number);
      else {
        setShowWarning(true);
        window.setTimeout(() => setShowWarning(false), 2200);
      }
      return next;
    });
  };
  const selectedCards = [...selected].sort((a, b) => a - b);
  return (
    <AppShell tab={tab} setTab={setTab}>
      {tab === 'wallet' ? <WalletPanel /> : <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Stats play={selected.size * STAKE} pot={(taken.size + selected.size) * 40} cardsTaken={taken.size + selected.size} />
        <SoundCountdown muted={muted} onToggle={() => setMuted((value) => !value)} countdown={countdown} />
        <div className="min-h-0 flex-1 overflow-y-auto"><NumberGrid selected={selected} taken={taken} onToggle={toggle} /></div>
        {selectedCards.length > 0 && <div className="pointer-events-none absolute bottom-[74px] left-0 right-0 z-10 flex gap-2 overflow-hidden bg-gradient-to-t from-[hsl(161_42%_9%)] to-transparent px-3 pb-2 pt-8">{selectedCards.map((id) => <MiniCard key={id} id={id} grid={buildCard(id)} />)}</div>}
        {showWarning && <div role="alert" data-testid="status-card-limit" className="absolute left-4 right-4 top-24 z-30 rounded-2xl border border-[hsl(var(--primary)/.6)] bg-[hsl(161_35%_15%/.98)] px-4 py-3 text-center text-sm font-bold text-[hsl(var(--primary))] shadow-xl animate-rise-in">ከ4 ካርድ በላይ መምረጥ አይችሉም</div>}
      </div>}
    </AppShell>
  );
}

function CalledBoard({ called, latest }: { called: Set<number>; latest: number | null }) {
  const columns = ['B', 'I', 'N', 'G', 'O'];
  return <section className="depth-surface relative rounded-2xl border border-[hsl(var(--accent)/.25)] bg-[hsl(161_35%_15%)] px-2 py-2 shadow-[0_0_18px_hsl(var(--accent)/.06)]"><div className="space-y-1">{columns.map((letter, row) => <div key={letter} className="grid grid-cols-[16px_repeat(15,minmax(0,1fr))] items-center gap-1"><span className="text-lg font-extrabold leading-none text-[hsl(var(--foreground))]">{letter}</span>{Array.from({ length: 15 }, (_, index) => { const number = row * 15 + index + 1; return <span key={number} data-testid={`status-called-${number}`} className={`grid aspect-[1.8] place-items-center rounded-sm font-mono text-[8px] font-bold transition-all ${latest === number ? 'called-number bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : called.has(number) ? 'called-number bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'bg-[hsl(159_22%_21%)] text-[hsl(var(--muted-foreground)/.65)]'}`}>{number}</span>; })}</div>)}</div></section>;
}

function CalledPanel({ current, muted, onToggle, callIndex, called }: { current: number | null; muted: boolean; onToggle: () => void; callIndex: number; called: Set<number> }) {
  const currentLetter = current ? ['B', 'I', 'N', 'G', 'O'][Math.min(4, Math.floor((current - 1) / 15))] : '?';
  const recentCalls = Array.from(called).slice(-3, -1);
  return <section className="depth-surface live-call-panel relative flex items-center gap-3 rounded-2xl border border-[hsl(var(--accent)/.35)] bg-[hsl(161_35%_15%)] p-3 shadow-[0_8px_30px_hsl(var(--accent)/.08)]"><div key={current ?? 'waiting'} className="live-call-orb spin-reveal-ball relative grid h-[76px] w-[76px] shrink-0 place-items-center rounded-full font-mono text-3xl font-bold text-[hsl(var(--primary-foreground))]"><span className="absolute -inset-1 rounded-full border border-[hsl(var(--primary)/.35)] animate-pulse-ring" /><span className="absolute top-2 text-xs font-extrabold">{currentLetter}</span><span className="call-ball-value mt-3">{current ?? '—'}</span></div><div className="min-w-0 flex-1"><div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-[hsl(var(--muted-foreground))]"><Timer className="h-3.5 w-3.5 text-[hsl(var(--primary))]" /> LIVE CALL</div><h2 className="mt-1 truncate text-lg font-extrabold">{current ? `ቁጥር ${current} ተጠርቷል` : 'ጨዋታው ይጀምራል'}</h2><div className="mt-2 flex gap-1.5">{recentCalls.map((number) => <span key={number} className="rounded-full bg-[hsl(var(--primary))] px-2.5 py-1 font-mono text-xs font-bold text-[hsl(var(--primary-foreground))]">{number}</span>)}</div></div><div className="flex shrink-0 flex-col items-center gap-1"><button type="button" data-testid="button-play-mute" onClick={onToggle} aria-label={muted ? 'ድምፅ አብራ' : 'ድምፅ ዝጋ'} className={`grid h-10 w-10 place-items-center rounded-xl border transition-colors ${muted ? 'border-[hsl(var(--destructive)/.7)] text-[hsl(var(--destructive))]' : 'border-[hsl(var(--accent)/.7)] text-[hsl(var(--accent))]'}`}>{muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}</button><span data-testid="text-called-count" className="font-mono text-xl font-bold">{called.size}/75</span></div></section>;
}

type WinnerPattern = { line: number[]; corners: number[] };

function findWinnerPattern(grid: Cell[], called: Set<number>): WinnerPattern | null {
  const isMarked = (cell: Cell) => cell === 'star' || (typeof cell === 'number' && called.has(cell));
  const corners = [0, 4, 20, 24];
  const cornersComplete = corners.every((index) => isMarked(grid[index]));
  const lines = [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8, 9],
    [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19],
    [20, 21, 22, 23, 24],
    [0, 5, 10, 15, 20],
    [1, 6, 11, 16, 21],
    [2, 7, 12, 17, 22],
    [3, 8, 13, 18, 23],
    [4, 9, 14, 19, 24],
    [0, 6, 12, 18, 24],
    [4, 8, 12, 16, 20],
  ];
  const line = lines.find((indexes) => indexes.every((index) => isMarked(grid[index])));
  if (!line && !cornersComplete) return null;
  return { line: line ?? [], corners: cornersComplete ? corners : [] };
}

function PlayCard({ id, grid, called, winner, winnerEffect = 0, finalNumber }: { id: number; grid: Cell[]; called: Set<number>; winner?: WinnerPattern | null; winnerEffect?: number; finalNumber?: number | null }) {
  const marked = grid.filter((cell) => cell === 'star' || (typeof cell === 'number' && called.has(cell))).length;
  return <section className={`depth-card rounded-2xl border bg-[hsl(161_35%_15%)] p-2.5 transition-transform hover:-translate-y-0.5 ${winner ? 'winner-card border-[hsl(var(--primary))]' : 'border-[hsl(var(--primary)/.35)]'}`}><div className="mb-2 flex items-center justify-between"><span className="font-mono text-xs font-bold text-[hsl(var(--primary))]">CARD #{id}</span><span className="text-[10px] font-bold text-[hsl(var(--muted-foreground))]">{marked}/25</span></div><div className="mb-1 grid grid-cols-5 gap-1 text-center text-[9px] font-extrabold text-[hsl(var(--primary))]"><span>B</span><span>I</span><span>N</span><span>G</span><span>O</span></div><div className="grid grid-cols-5 gap-1">{grid.map((cell, index) => { const hit = cell === 'star' || (typeof cell === 'number' && called.has(cell)); const onLine = winner?.line.includes(index); const isCorner = winner?.corners.includes(index); const isFinalNumber = typeof cell === 'number' && cell === finalNumber; const effectClass = onLine ? `winner-line-cell winner-effect-${winnerEffect}` : isCorner ? 'winner-corner-cell' : hit ? 'called-number' : ''; const finalEffectClass = isFinalNumber ? `winner-final-number winner-effect-${winnerEffect}` : ''; return <div key={`${id}-${index}`} data-testid={`cell-card-${id}-${index}`} className={`grid aspect-square place-items-center rounded-md text-[11px] font-bold transition-all duration-300 ${effectClass} ${finalEffectClass} ${onLine ? 'bg-[hsl(var(--destructive))] text-[hsl(var(--foreground))]' : isCorner ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]' : hit ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_2px_0_hsl(152_61%_30%)]' : 'bg-[hsl(159_22%_22%)] text-[hsl(var(--foreground)/.8)]'}`}>{cell === 'star' ? '✦' : cell}</div>; })}</div></section>;
}

function WinnerModal({ card, called, pattern, winnerEffect, prize }: { card: { id: number; grid: Cell[] }; called: Set<number>; pattern: WinnerPattern; winnerEffect: number; prize: number }) {
  return (
    <div className='winner-overlay fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-8' role='dialog' aria-modal='true' aria-label='Bingo winner'>
      <div className='winner-confetti' aria-hidden='true'>
        {Array.from({ length: 34 }, (_, index) => <span key={index} className={`confetti-piece confetti-piece-${index % 6}`} />)}
      </div>
      <div className='winner-modal relative w-full max-w-[430px] text-center'>
        <div className='winner-trophy' aria-hidden='true'>🏆</div>
        <p className='winner-title'>BINGO WINNER!</p>
        <p className='winner-prize-label'>TOTAL PRIZE</p>
        <p className='winner-prize'>{prize.toLocaleString("en-US", { minimumFractionDigits: 2 })} <span>ብር</span></p>
        <div className='winner-summary'>Name: <strong>ዜድ</strong> <span>|</span> Card: <strong>#{card.id}</strong></div>
        <div className='winner-card-frame'>
          <PlayCard id={card.id} grid={card.grid} called={called} winner={pattern} winnerEffect={winnerEffect} finalNumber={Array.from(called).at(-1)} />
        </div>
      </div>
    </div>
  );
}

function Play() {
  const [location, setLocation] = useLocation();
  const [muted, setMuted] = useState(true);
  const [tab, setTab] = useState<Tab>('bingo');
  const [round, setRound] = useState<RoundData | null>(null);
  const [cards, setCards] = useState<Array<{ id: number; grid: Cell[] }>>([]);
  const query = new URLSearchParams(location.split('?')[1] ?? '');
  const roundId = query.get('round');
  const called = useMemo(() => new Set((round?.calls ?? []).map((call) => call.number)), [round]);
  const current = round?.calls.at(-1)?.number ?? null;
  const winnerEffect = String(round?.id ?? roundId ?? '').split('').reduce((total, character) => total + character.charCodeAt(0), 0) % 4;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const roundResponse = await fetch(`${getApiUrl()}/api/bingo/round`);
      if (!roundResponse.ok) return;
      const nextRound = await roundResponse.json() as RoundData;
      const cardResponse = await fetch(`${getApiUrl()}/api/bingo/cards`, { headers: telegramHeaders() });
      const cardData = cardResponse.ok ? await cardResponse.json() as { cards: ServerCard[] } : { cards: [] };
      if (!cancelled) { setRound(nextRound); setCards(cardData.cards.map((card) => ({ id: card.cardNumber, grid: card.grid }))); }
    };
    void load().catch(() => undefined);
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, CALL_INTERVAL);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [roundId]);
  const winnerMatch = useMemo(() => cards.map((card) => ({ card, pattern: findWinnerPattern(card.grid, called) })).find(({ pattern }) => pattern) ?? null, [called, cards]);
  useEffect(() => { if (!winnerMatch) return; const timer = window.setTimeout(() => setLocation('/'), 6000); return () => window.clearTimeout(timer); }, [setLocation, winnerMatch]);
  return <AppShell tab={tab} setTab={setTab}>{tab === 'wallet' ? <WalletPanel /> : <div className="min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,hsl(161_42%_9%),hsl(161_48%_7%))] p-3"><div className="space-y-3"><CalledBoard called={called} latest={current} /><CalledPanel current={current} muted={muted} onToggle={() => setMuted((value) => !value)} callIndex={round?.calls.length ?? 0} called={called} /><div className="grid grid-cols-2 gap-2.5">{cards.map((card) => { const pattern = winnerMatch?.card.id === card.id ? winnerMatch.pattern : null; return <PlayCard key={card.id} {...card} called={called} winner={pattern} />; })}</div><div className="flex items-center justify-center gap-2 pb-2 text-[11px] text-[hsl(var(--muted-foreground))]"><Sparkles className="h-3.5 w-3.5 text-[hsl(var(--primary))]" /> ቁጥሮች በየ 3 ሰከንዱ ይጠራሉ</div></div></div>}{winnerMatch && <WinnerModal card={winnerMatch.card} called={called} pattern={winnerMatch.pattern!} winnerEffect={winnerEffect} prize={2280} />}</AppShell>;
}

function AppShell({ children, tab, setTab }: { children: ReactNode; tab: Tab; setTab: (tab: Tab) => void }) {
  return <main className="game-grain depth-stage mx-auto flex h-[100dvh] max-w-[520px] flex-col overflow-hidden overscroll-none bg-[hsl(var(--background))] text-[hsl(var(--foreground))] shadow-2xl"><Header />{children}<BottomNav active={tab} onChange={setTab} /></main>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={Home} /><Route path="/play" component={Play} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
