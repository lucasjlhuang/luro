import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import Peer, { DataConnection } from 'peerjs';

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type Role = 'USER_A' | 'USER_B';
export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
export type ModalType =
  | 'NONE'
  | 'TIMER'
  | 'NOTEBOOK'
  | 'CORKBOARD'
  | 'WHITEBOARD'
  | 'HABITS'
  | 'WARDROBE'
  | 'SETTINGS'
  | 'SPEECH';
export type TaskStatus = 'TODO' | 'IN_PROGRESS';
export type TimerMode = 'WORK' | 'BREAK';
export type CharacterStatus = 'IDLE' | 'WORKING' | 'SLEEPING';

const VALID_STATUSES: readonly CharacterStatus[] = ['IDLE', 'WORKING', 'SLEEPING'];

/** Guards against stale persisted values / older peers (e.g. removed 'RELAXING'). */
const sanitizeStatus = (status: CharacterStatus): CharacterStatus =>
  VALID_STATUSES.includes(status) ? status : 'IDLE';

export interface Bubble {
  text: string;
  updatedAt: number;
}

/** Live character transform streamed while the partner wanders/drags. */
export interface CharPos {
  x: number;
  z: number;
  yaw: number;
  carried: boolean;
  t: number;
}

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Accessories are listed once, here, so the wardrobe panel can render them
 * generically — adding a scarf later means one entry plus its geometry, not a
 * new checkbox wired up by hand.
 *
 * `roles` limits who the option is offered to: the packs differ, and a toggle
 * for a mesh a model does not have (Roro has no cloak) is a lie in the UI.
 * `label` can differ per role — the same `outfit_hat` mesh is a wizard hat on
 * Lulu and a hood on Roro.
 */
export type AccessoryKey =
  | 'hat'
  | 'cape'
  | 'staff'
  | 'glasses'
  | 'flowerCrown'
  | 'bow'
  | 'earrings'
  | 'headphones'
  | 'scarf'
  | 'crown'
  | 'backpack';

export const ACCESSORY_DEFS: Array<{
  key: AccessoryKey;
  roles: Role[];
  label: Partial<Record<Role, string>> & { default: string };
}> = [
  { key: 'hat', roles: ['USER_A', 'USER_B'], label: { default: 'Hat', USER_B: 'Hood' } },
  { key: 'cape', roles: ['USER_A'], label: { default: 'Cape' } },
  { key: 'staff', roles: ['USER_A', 'USER_B'], label: { default: 'Staff (at work)' } },
  { key: 'glasses', roles: ['USER_A', 'USER_B'], label: { default: 'Glasses' } },
  { key: 'flowerCrown', roles: ['USER_A', 'USER_B'], label: { default: 'Flower crown' } },
  { key: 'bow', roles: ['USER_A', 'USER_B'], label: { default: 'Hair bow' } },
  { key: 'earrings', roles: ['USER_A', 'USER_B'], label: { default: 'Earrings' } },
  { key: 'headphones', roles: ['USER_A', 'USER_B'], label: { default: 'Headphones' } },
  { key: 'scarf', roles: ['USER_A', 'USER_B'], label: { default: 'Scarf' } },
  { key: 'crown', roles: ['USER_A', 'USER_B'], label: { default: 'Crown' } },
  { key: 'backpack', roles: ['USER_A', 'USER_B'], label: { default: 'Backpack' } },
];

export const accessoriesFor = (role: Role) =>
  ACCESSORY_DEFS.filter((a) => a.roles.includes(role));

export const accessoryLabel = (key: AccessoryKey, role: Role): string => {
  const def = ACCESSORY_DEFS.find((a) => a.key === key);
  return def?.label[role] ?? def?.label.default ?? key;
};

/**
 * Same principle as ACCESSORY_DEFS.roles, for the pattern print: it is only
 * implemented for Roro's dress and hood, so Lulu's tab must not offer it.
 * Extend the list when a character gains a printable garment.
 */
export const PATTERN_ROLES: Role[] = ['USER_A', 'USER_B'];
/** 'stars' and 'moons' are PYJAMA-ONLY: the night look sets them internally
 * (stars on Roro, moons on Lulu) and the picker never offers them. */
export type PatternKey = 'none' | 'flowers' | 'stars' | 'moons' | 'stripes' | 'plaid';

export const PATTERNS: Array<{ key: PatternKey; label: string }> = [
  { key: 'none', label: 'Plain' },
  { key: 'flowers', label: 'Flowers' },
  { key: 'stripes', label: 'Stripes' },
  { key: 'plaid', label: 'Plaid' },
];

/**
 * Default print colour when none is chosen: motif prints read best in the
 * accent pink, woven prints (stripes/plaid) in the garment's own trim shade.
 */
export const patternDefaultColor = (pattern: PatternKey, trim: string): string =>
  pattern === 'stripes' || pattern === 'plaid' ? trim : '#EC93B8';

export interface Appearance {
  /** Hair runs as a gradient: roots at the top, tips at the bottom. */
  hairTop: string;
  hairBottom: string;
  eyes: string;
  /** Main garment — Roro's dress, Lulu's tunic. */
  outfit: string;
  trim: string;
  freckles: boolean;
  blush: boolean;
  pattern: PatternKey;
  /** null = the pattern's own default (pink motifs, trim-coloured weaves). */
  patternColor: string | null;
  accessories: Record<AccessoryKey, boolean>;
  /**
   * null = FOLLOW the outfit: Lulu's hat/cape track his trim colour, Roro's
   * hood tracks her dress, until a specific colour is chosen. Storing a hex at
   * creation would freeze it — change the trim later and the cape would not
   * come along.
   */
  hatColor: string | null;
  capeColor: string | null;
}

/** The looks we arrived at by hand; the panel starts from these. */
const DEFAULT_APPEARANCE: Record<Role, Appearance> = {
  USER_A: {
    hairTop: '#1A120B',
    hairBottom: '#1A120B',
    eyes: '#6B4A24',
    outfit: '#7D956D',
    trim: '#5A6B4E',
    freckles: true,
    blush: false,
    pattern: 'none',
    patternColor: null,
    accessories: {
      hat: false,
      cape: false,
      staff: true,
      glasses: false,
      flowerCrown: false,
      bow: false,
      earrings: false,
      headphones: false,
      scarf: false,
      crown: false,
      backpack: false,
    },
    hatColor: null,
    capeColor: null,
  },
  USER_B: {
    hairTop: '#4A250C',
    hairBottom: '#9C5518',
    eyes: '#7D956D',
    outfit: '#7D956D',
    trim: '#5A6B4E',
    freckles: false,
    blush: true,
    pattern: 'flowers',
    patternColor: null,
    accessories: {
      hat: false,
      cape: false,
      staff: true,
      glasses: false,
      flowerCrown: false,
      bow: false,
      earrings: false,
      headphones: false,
      scarf: false,
      crown: false,
      backpack: false,
    },
    hatColor: null,
    capeColor: null,
  },
};

export interface AppearanceState {
  looks: Record<Role, Appearance>;
  updatedAt: number;
}

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

/** Guards colours and unknown keys coming from a peer or an older build. */
const sanitizeAppearance = (state: AppearanceState | undefined): AppearanceState => {
  const one = (role: Role): Appearance => {
    const d = DEFAULT_APPEARANCE[role];
    const a = state?.looks?.[role];
    if (!a) return { ...d, accessories: { ...d.accessories } };
    const pick = (v: unknown, fb: string) => (isHex(v) ? v : fb);
    return {
      hairTop: pick(a.hairTop, d.hairTop),
      hairBottom: pick(a.hairBottom, d.hairBottom),
      eyes: pick(a.eyes, d.eyes),
      outfit: pick(a.outfit, d.outfit),
      trim: pick(a.trim, d.trim),
      freckles: a.freckles === true,
      blush: a.blush === true,
      pattern: PATTERNS.some((pt) => pt.key === a.pattern) ? a.pattern : 'none',
      patternColor: isHex(a.patternColor) ? a.patternColor : null,
      accessories: ACCESSORY_DEFS.reduce(
        (acc, { key }) => ({ ...acc, [key]: a.accessories?.[key] === true }),
        {} as Record<AccessoryKey, boolean>
      ),
      hatColor: isHex(a.hatColor) ? a.hatColor : null,
      capeColor: isHex(a.capeColor) ? a.capeColor : null,
    };
  };
  return { updatedAt: state?.updatedAt ?? 0, looks: { USER_A: one('USER_A'), USER_B: one('USER_B') } };
};

/** Monday-first, so `days[0]` is Monday and `days[6]` Sunday. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Activity names are kept short so a row fits the grid without wrapping. */
export const HABIT_NAME_MAX = 15;

export interface Habit {
  id: string;
  name: string;
  /** Who added it — the row is colour-coded by author. */
  author: Role;
  /** Seven ticks, Monday..Sunday. */
  days: boolean[];
}

/**
 * The habit board is SHARED, not per-user: one grid both people edit, unlike
 * tasks and notes which are mine/theirs. Resolved last-write-wins on
 * `updatedAt`, the same way the timer and lighting are.
 */
export interface HabitBoard {
  habits: Habit[];
  updatedAt: number;
}

/** Guards against a peer or an old persisted board sending a short row. */
const sanitizeHabits = (board: HabitBoard): HabitBoard => ({
  updatedAt: board?.updatedAt ?? 0,
  habits: (board?.habits ?? []).map((h) => ({
    id: String(h.id),
    name: String(h.name ?? '').slice(0, HABIT_NAME_MAX),
    author: h.author === 'USER_B' ? 'USER_B' : 'USER_A',
    days: Array.from({ length: 7 }, (_, i) => h.days?.[i] === true),
  })),
});

/** A whiteboard stroke; points are normalized [x0, y0, x1, y1, ...] in 0..1. */
export interface Stroke {
  id: string;
  author: Role;
  color: string;
  size: number;
  erase: boolean;
  points: number[];
  t: number;
}

export interface TimerState {
  isRunning: boolean;
  mode: TimerMode;
  /** Epoch ms the countdown finishes; only set while running. */
  endsAt: number | null;
  /** Remaining ms while paused / idle. */
  remainingMs: number;
  workMin: number;
  breakMin: number;
  /** Last-write-wins conflict resolution across peers. */
  updatedAt: number;
}

/**
 * Peer ids are namespaced by a shared PAIR CODE, not fixed globally.
 *
 * They used to be two constants, which meant every install on earth competed for the
 * same two ids on the public broker: hand the app to anyone else and whoever
 * launched first held the slot, locking your actual partner out — and they
 * would have received your notes, tasks and habits on connect. Both people
 * enter the same code; anyone with a different code is in a different room.
 */
export const PAIR_CODE_MAX = 12;

/** Codes are compared after normalising, so case and spacing cannot mismatch. */
export const normalizeCode = (code: string): string =>
  code
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, PAIR_CODE_MAX);

export const peerIdFor = (code: string, role: Role): string =>
  `luro-${normalizeCode(code) || 'default'}-${role === 'USER_A' ? 'a' : 'b'}`;

/** Fresh installs get their own room rather than sharing one global pair. */
const makePairCode = (): string => Math.random().toString(36).slice(2, 8);

export const partnerOf = (role: Role): Role => (role === 'USER_A' ? 'USER_B' : 'USER_A');

/* ------------------------------------------------------------------ */
/* Sync protocol                                                      */
/* ------------------------------------------------------------------ */

interface FullSyncPayload {
  role: Role;
  myNotes: string;
  myTasks: Task[];
  strokes: Stroke[];
  isNightMode: boolean;
  lightingUpdatedAt: number;
  timer: TimerState;
  myStatus: CharacterStatus;
  myBubble: Bubble;
  habits: HabitBoard;
  appearance: AppearanceState;
}

type SyncMessage =
  | { type: 'NOTE_UPDATE'; payload: string }
  | { type: 'TASK_UPDATE'; payload: Task[] }
  | { type: 'HABITS'; payload: HabitBoard }
  | { type: 'APPEARANCE'; payload: AppearanceState }
  | { type: 'STROKE_ADD'; payload: Stroke }
  | { type: 'WHITEBOARD_CLEAR' }
  | { type: 'LIGHTING'; payload: { isNightMode: boolean; updatedAt: number } }
  | { type: 'TIMER'; payload: TimerState }
  | { type: 'STATUS'; payload: CharacterStatus }
  | { type: 'BUBBLE'; payload: Bubble }
  | { type: 'CHAR_POS'; payload: CharPos }
  | { type: 'FULL_SYNC'; payload: FullSyncPayload };

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

export interface AppState {
  role: Role;
  connectionStatus: ConnectionStatus;
  activeModal: ModalType;

  myNotes: string;
  partnerNotes: string;
  myTasks: Task[];
  partnerTasks: Task[];
  habits: HabitBoard;
  /** Both characters' looks — shared, so each desk shows the same pair. */
  appearance: AppearanceState;
  /** Shared room code; both desks must match. */
  pairCode: string;
  /** True once a character was picked by hand — unpinned installs auto-claim. */
  rolePinned: boolean;
  isNightMode: boolean;
  lightingUpdatedAt: number;
  strokes: Stroke[];
  timer: TimerState;
  /** Last pen colour the local user drew with (mirrored by the 3D marker). */
  penColor: string;
  myStatus: CharacterStatus;
  partnerStatus: CharacterStatus;
  /** Ephemeral speech bubbles (not persisted; expire client-side). */
  myBubble: Bubble;
  partnerBubble: Bubble;
  /** Last received partner character transform (ephemeral). */
  partnerCharPos: CharPos | null;

  initPeer: () => void;
  setRole: (role: Role) => void;
  setPairCode: (code: string) => void;
  setActiveModal: (modal: ModalType) => void;

  setMyNotes: (text: string) => void;
  addTask: (text: string) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  setAppearance: (role: Role, patch: Partial<Appearance>) => void;
  addHabit: (name: string) => void;
  renameHabit: (id: string, name: string) => void;
  toggleHabitDay: (id: string, day: number) => void;
  deleteHabit: (id: string) => void;
  deleteTask: (id: string) => void;
  toggleNightMode: () => void;
  addLocalStroke: (stroke: Omit<Stroke, 'id' | 'author' | 't'>) => void;
  clearWhiteboard: () => void;
  setPenColor: (color: string) => void;
  setMyStatus: (status: CharacterStatus) => void;
  setMyBubble: (text: string) => void;
  /** Fire-and-forget position broadcast; does not touch local state. */
  sendCharPos: (pos: Omit<CharPos, 't'>) => void;

  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  setTimerMode: (mode: TimerMode) => void;
  setTimerDurations: (workMin: number, breakMin: number) => void;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const durationMsFor = (mode: TimerMode, timer: TimerState): number =>
  (mode === 'WORK' ? timer.workMin : timer.breakMin) * 60_000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      role: 'USER_A',
      connectionStatus: 'DISCONNECTED',
      activeModal: 'NONE',

      myNotes: '',
      partnerNotes: '',
      myTasks: [],
      habits: { habits: [], updatedAt: 0 },
      appearance: sanitizeAppearance(undefined),
      pairCode: makePairCode(),
      rolePinned: false,
      partnerTasks: [],
      isNightMode: false,
      lightingUpdatedAt: 0,
      strokes: [],
      penColor: '#1e293b',
      myStatus: 'IDLE',
      partnerStatus: 'IDLE',
      myBubble: { text: '', updatedAt: 0 },
      partnerBubble: { text: '', updatedAt: 0 },
      partnerCharPos: null,
      timer: {
        isRunning: false,
        mode: 'WORK',
        endsAt: null,
        remainingMs: 25 * 60_000,
        workMin: 25,
        breakMin: 5,
        updatedAt: 0,
      },

      initPeer: () => startEngine(),

      setRole: (role) => {
        // Picking by hand pins it: this desk will hold that character and keep
        // retrying rather than auto-swapping to the other one.
        if (role === get().role) {
          set({ rolePinned: true });
          return;
        }
        set({ role, rolePinned: true, connectionStatus: 'DISCONNECTED' });
        createPeer();
      },

      setPairCode: (code) => {
        const next = normalizeCode(code);
        if (next === get().pairCode) return;
        set({ pairCode: next, connectionStatus: 'DISCONNECTED' });
        createPeer();
      },

      setActiveModal: (modal) => set({ activeModal: modal }),

      setMyNotes: (text) => {
        set({ myNotes: text });
        broadcast({ type: 'NOTE_UPDATE', payload: text });
      },

      /* Appearance is shared like the habit board: republish the whole thing
         and let the newer timestamp win. Either desk may dress either
         character — they are building one room together. */
      setAppearance: (role, patch) => {
        const cur = get().appearance;
        set({
          appearance: {
            looks: { ...cur.looks, [role]: { ...cur.looks[role], ...patch } },
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'APPEARANCE', payload: get().appearance });
      },

      /* Habits are a single shared board: every edit republishes the whole
         thing with a fresh timestamp, and the peer takes it if it is newer.
         Same last-write-wins as the timer — simultaneous edits on both ends
         can drop one, which is fine for two people and one small grid. */
      addHabit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set({
          habits: {
            habits: [
              ...get().habits.habits,
              {
                id: uid(),
                name: trimmed.slice(0, HABIT_NAME_MAX),
                author: get().role,
                days: Array.from({ length: 7 }, () => false),
              },
            ],
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      renameHabit: (id, name) => {
        set({
          habits: {
            habits: get().habits.habits.map((h) =>
              h.id === id ? { ...h, name: name.slice(0, HABIT_NAME_MAX) } : h
            ),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      toggleHabitDay: (id, day) => {
        if (day < 0 || day > 6) return;
        set({
          habits: {
            habits: get().habits.habits.map((h) =>
              h.id === id ? { ...h, days: h.days.map((d, i) => (i === day ? !d : d)) } : h
            ),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      deleteHabit: (id) => {
        set({
          habits: {
            habits: get().habits.habits.filter((h) => h.id !== id),
            updatedAt: Date.now(),
          },
        });
        broadcast({ type: 'HABITS', payload: get().habits });
      },

      addTask: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const myTasks: Task[] = [
          ...get().myTasks,
          { id: uid(), text: trimmed, status: 'TODO', createdAt: Date.now() },
        ];
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      updateTaskStatus: (id, status) => {
        const myTasks = get().myTasks.map((t) => (t.id === id ? { ...t, status } : t));
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      deleteTask: (id) => {
        const myTasks = get().myTasks.filter((t) => t.id !== id);
        set({ myTasks });
        broadcast({ type: 'TASK_UPDATE', payload: myTasks });
      },

      toggleNightMode: () => {
        const isNightMode = !get().isNightMode;
        const lightingUpdatedAt = Date.now();
        set({ isNightMode, lightingUpdatedAt });
        broadcast({ type: 'LIGHTING', payload: { isNightMode, updatedAt: lightingUpdatedAt } });
      },

      addLocalStroke: (partial) => {
        const stroke = compactStroke({
          ...partial,
          id: uid(),
          author: get().role,
          t: Date.now(),
        });
        set({ strokes: [...get().strokes, stroke].slice(-MAX_STROKES) });
        broadcast({ type: 'STROKE_ADD', payload: stroke });
      },

      clearWhiteboard: () => {
        set({ strokes: [] });
        broadcast({ type: 'WHITEBOARD_CLEAR' });
      },

      setPenColor: (color) => set({ penColor: color }),

      setMyStatus: (status) => {
        set({ myStatus: status });
        broadcast({ type: 'STATUS', payload: status });
      },

      setMyBubble: (text) => {
        const myBubble: Bubble = { text: text.trim(), updatedAt: Date.now() };
        set({ myBubble });
        broadcast({ type: 'BUBBLE', payload: myBubble });
      },

      sendCharPos: (pos) => {
        broadcast({ type: 'CHAR_POS', payload: { ...pos, t: Date.now() } });
      },

      startTimer: () => {
        const t = get().timer;
        if (t.isRunning) return;
        const remaining = t.remainingMs > 500 ? t.remainingMs : durationMsFor(t.mode, t);
        const timer: TimerState = {
          ...t,
          isRunning: true,
          endsAt: Date.now() + remaining,
          remainingMs: remaining,
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      pauseTimer: () => {
        const t = get().timer;
        if (!t.isRunning || t.endsAt === null) return;
        const timer: TimerState = {
          ...t,
          isRunning: false,
          remainingMs: Math.max(0, t.endsAt - Date.now()),
          endsAt: null,
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      resetTimer: () => {
        const t = get().timer;
        const timer: TimerState = {
          ...t,
          isRunning: false,
          endsAt: null,
          remainingMs: durationMsFor(t.mode, t),
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      setTimerMode: (mode) => {
        const t = get().timer;
        const timer: TimerState = {
          ...t,
          mode,
          isRunning: false,
          endsAt: null,
          remainingMs: durationMsFor(mode, t),
          updatedAt: Date.now(),
        };
        set({ timer });
        broadcast({ type: 'TIMER', payload: timer });
      },

      setTimerDurations: (workMin, breakMin) => {
        const t = get().timer;
        const next: TimerState = {
          ...t,
          workMin: clamp(workMin, 5, 90),
          breakMin: clamp(breakMin, 1, 30),
          updatedAt: Date.now(),
        };
        if (!next.isRunning) next.remainingMs = durationMsFor(next.mode, next);
        set({ timer: next });
        broadcast({ type: 'TIMER', payload: next });
      },
    }),
    {
      name: 'desk-overlay-storage',
      partialize: (s) => ({
        role: s.role,
        myNotes: s.myNotes,
        partnerNotes: s.partnerNotes,
        myTasks: s.myTasks,
        partnerTasks: s.partnerTasks,
        habits: s.habits,
        appearance: s.appearance,
        pairCode: s.pairCode,
        rolePinned: s.rolePinned,
        isNightMode: s.isNightMode,
        lightingUpdatedAt: s.lightingUpdatedAt,
        strokes: s.strokes,
        penColor: s.penColor,
        myStatus: s.myStatus,
        partnerStatus: s.partnerStatus,
        timer: s.timer,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // A timer persisted mid-run is stale after a restart; freeze it.
        if (state.timer.isRunning) {
          const remaining = state.timer.endsAt ? Math.max(0, state.timer.endsAt - Date.now()) : 0;
          useAppStore.setState({
            timer: { ...state.timer, isRunning: false, endsAt: null, remainingMs: remaining },
          });
        }
        // A board persisted by an older build may predate the habit grid or
        // the wardrobe; both sanitizers fill in whatever is missing.
        useAppStore.setState({
          habits: sanitizeHabits(state.habits ?? { habits: [], updatedAt: 0 }),
          appearance: sanitizeAppearance(state.appearance),
        });
        // Statuses persisted by an older build may no longer exist.
        useAppStore.setState({
          myStatus: sanitizeStatus(state.myStatus),
          partnerStatus: sanitizeStatus(state.partnerStatus),
        });
      },
    }
  )
);

/* ------------------------------------------------------------------ */
/* PeerJS auto-connect engine                                         */
/*                                                                    */
/* Both roles register under a static, well-known peer ID and keep    */
/* dialing the partner ID until a data channel opens — no room codes. */
/* Peer/connection objects are module-level singletons (never put     */
/* non-serializable network handles inside persisted state).          */
/* ------------------------------------------------------------------ */

let peer: Peer | null = null;
const conns = new Set<DataConnection>();
let retryTimer: ReturnType<typeof setInterval> | null = null;
let recreateTimer: ReturnType<typeof setTimeout> | null = null;
let engineStarted = false;

function startEngine(): void {
  if (engineStarted) return;
  engineStarted = true;
  createPeer();
}

function destroyPeer(): void {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (recreateTimer !== null) {
    clearTimeout(recreateTimer);
    recreateTimer = null;
  }
  conns.forEach((c) => {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  });
  conns.clear();
  if (peer) {
    try {
      peer.destroy();
    } catch {
      /* already destroyed */
    }
    peer = null;
  }
}

function createPeer(): void {
  destroyPeer();
  const { role } = useAppStore.getState();
  useAppStore.setState({ connectionStatus: 'CONNECTING' });

  const p = new Peer(peerIdFor(useAppStore.getState().pairCode, role), { debug: 0 });
  peer = p;

  p.on('open', () => {
    tryConnect();
    retryTimer = setInterval(tryConnect, 4000);
  });

  // The partner dialed us — same channel, opposite direction.
  p.on('connection', (c) => wireConnection(c));

  p.on('disconnected', () => {
    if (peer === p && !p.destroyed) {
      try {
        p.reconnect();
      } catch {
        /* fatal state; recreate below via error handler */
      }
    }
  });

  p.on('error', (err) => {
    const type = (err as { type?: string }).type;
    if (type === 'unavailable-id') {
      const { rolePinned, role } = useAppStore.getState();
      useAppStore.setState({ connectionStatus: 'DISCONNECTED' });
      // A desk that has never chosen a character claims one: it asks for Lulu
      // first and takes Roro if Lulu is already held, so the second install to
      // start pairs up on its own with nobody touching a setting. Picking by
      // hand pins the choice, and a pinned desk waits for its own id instead.
      if (!rolePinned && role === 'USER_A') {
        useAppStore.setState({ role: 'USER_B' });
        if (peer === p) createPeer();
        return;
      }
      recreateTimer = setTimeout(() => {
        if (peer === p) createPeer();
      }, 6000);
    }
    // 'peer-unavailable' just means the partner is offline; the retry
    // interval keeps dialing until they appear.
  });
}

function tryConnect(): void {
  if (!peer || peer.destroyed || !peer.open) return;
  if ([...conns].some((c) => c.open)) return;
  const { role, pairCode } = useAppStore.getState();
  wireConnection(peer.connect(peerIdFor(pairCode, partnerOf(role)), { reliable: true }));
}

function refreshStatus(): void {
  const open = [...conns].some((c) => c.open);
  useAppStore.setState({
    connectionStatus: open ? 'CONNECTED' : peer && !peer.destroyed ? 'CONNECTING' : 'DISCONNECTED',
  });
}

function wireConnection(c: DataConnection): void {
  conns.add(c);
  c.on('open', () => {
    refreshStatus();
    c.send(buildFullSync());
  });
  c.on('data', (data) => handleMessage(data as SyncMessage));
  c.on('close', () => {
    conns.delete(c);
    refreshStatus();
  });
  c.on('error', () => {
    conns.delete(c);
    refreshStatus();
  });
}

function broadcast(msg: SyncMessage): void {
  conns.forEach((c) => {
    if (c.open) c.send(msg);
  });
}

function buildFullSync(): SyncMessage {
  const s = useAppStore.getState();
  return {
    type: 'FULL_SYNC',
    payload: {
      role: s.role,
      myNotes: s.myNotes,
      myTasks: s.myTasks,
      strokes: s.strokes,
      isNightMode: s.isNightMode,
      lightingUpdatedAt: s.lightingUpdatedAt,
      timer: s.timer,
      myStatus: s.myStatus,
      myBubble: s.myBubble,
      habits: s.habits,
      appearance: s.appearance,
    },
  };
}

/**
 * Whiteboard history is capped, and points are stored at 4 decimal places.
 *
 * Both matter for a long-lived install: strokes are persisted to localStorage,
 * which has a ~5MB quota, and full float precision runs ~18 characters per
 * coordinate. Left unbounded, months of drawing would eventually throw
 * QuotaExceededError on write — which does not just lose the drawing, it stops
 * notes, tasks and habits being saved too, since they share one persisted blob.
 * 4 decimals is sub-pixel on a normalised 0..1 board, and shrinks the network
 * payload by the same factor.
 */
const MAX_STROKES = 600;
const COORD_DP = 4;

const compactStroke = (s: Stroke): Stroke => ({
  ...s,
  points: s.points.map((v) => Math.round(v * 10 ** COORD_DP) / 10 ** COORD_DP),
});

function mergeStrokes(local: Stroke[], incoming: Stroke[]): Stroke[] {
  const byId = new Map<string, Stroke>();
  for (const s of [...local, ...incoming]) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  // oldest fall off the front once the cap is reached
  return [...byId.values()].sort((a, b) => a.t - b.t).slice(-MAX_STROKES);
}

function handleMessage(msg: SyncMessage): void {
  switch (msg.type) {
    case 'NOTE_UPDATE':
      useAppStore.setState({ partnerNotes: msg.payload });
      break;
    case 'TASK_UPDATE':
      useAppStore.setState({ partnerTasks: msg.payload });
      break;
    case 'APPEARANCE':
      useAppStore.setState((s) =>
        msg.payload.updatedAt >= s.appearance.updatedAt
          ? { appearance: sanitizeAppearance(msg.payload) }
          : {}
      );
      break;
    case 'HABITS':
      useAppStore.setState((s) =>
        msg.payload.updatedAt >= s.habits.updatedAt ? { habits: sanitizeHabits(msg.payload) } : {}
      );
      break;
    case 'STROKE_ADD':
      useAppStore.setState((s) =>
        s.strokes.some((x) => x.id === msg.payload.id)
          ? {}
          : { strokes: mergeStrokes(s.strokes, [msg.payload]) }
      );
      break;
    case 'WHITEBOARD_CLEAR':
      useAppStore.setState({ strokes: [] });
      break;
    case 'LIGHTING':
      useAppStore.setState((s) =>
        msg.payload.updatedAt >= s.lightingUpdatedAt
          ? { isNightMode: msg.payload.isNightMode, lightingUpdatedAt: msg.payload.updatedAt }
          : {}
      );
      break;
    case 'TIMER':
      useAppStore.setState((s) => (msg.payload.updatedAt >= s.timer.updatedAt ? { timer: msg.payload } : {}));
      break;
    case 'STATUS':
      useAppStore.setState({ partnerStatus: sanitizeStatus(msg.payload) });
      break;
    case 'BUBBLE':
      useAppStore.setState({ partnerBubble: msg.payload });
      break;
    case 'CHAR_POS':
      useAppStore.setState({ partnerCharPos: msg.payload });
      break;
    case 'FULL_SYNC': {
      const p = msg.payload;
      useAppStore.setState((s) => ({
        partnerNotes: p.myNotes,
        partnerTasks: p.myTasks,
        partnerStatus: sanitizeStatus(p.myStatus),
        partnerBubble: p.myBubble,
        strokes: mergeStrokes(s.strokes, p.strokes),
        ...(p.lightingUpdatedAt > s.lightingUpdatedAt
          ? { isNightMode: p.isNightMode, lightingUpdatedAt: p.lightingUpdatedAt }
          : {}),
        ...(p.timer.updatedAt > s.timer.updatedAt ? { timer: p.timer } : {}),
        ...((p.habits?.updatedAt ?? 0) > s.habits.updatedAt
          ? { habits: sanitizeHabits(p.habits) }
          : {}),
        ...((p.appearance?.updatedAt ?? 0) > s.appearance.updatedAt
          ? { appearance: sanitizeAppearance(p.appearance) }
          : {}),
      }));
      break;
    }
  }
}
