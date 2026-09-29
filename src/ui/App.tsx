import React, { useState, useEffect } from "react";
import {
  Activity,
  Key,
  Layers,
  Sliders,
  Plus,
  Trash2,
  Copy,
  Check,
  Zap,
  Terminal,
  LogOut,
  ExternalLink,
  Coins,
  AlertTriangle,
  RotateCcw,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  X,
  CheckCircle2,
  Eye,
  EyeOff,
  Boxes,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from "@floating-ui/react";

type ProviderPreset = {
  provider: string;
  label?: string;
  endpoint: string;
  auth?: "openai" | "anthropic";
};

type KeyItem = {
  id: string;
  name: string;
  key: string;
  isActive: boolean;
  tokenLimit: number | null;
  usedTokens: number;
  remainingTokens: number | null;
  quotaExhausted: boolean;
  rateLimit: number | null;
  allowedProviders: string[];
  createdAt: string;
};

type UpstreamItem = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  weight: number;
  isActive: boolean;
  models: { id: string; name?: string; enabled: boolean }[];
  keys: { id: string; key: string; isActive: boolean }[];
};

type TelemetryLog = {
  id: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  status: number;
  created_at: string;
};

type HistoryBar = {
  status: "success" | "warning" | "error" | "idle";
  latency: number;
  time: string;
};

type ModelManagementItem = {
  id: string;
  name: string;
  upstreamId: string;
  upstreamName: string;
  provider: string;
  enabled: boolean;
  upstreamActive: boolean;
  status: "normal" | "demote" | "offline";
  availability: number;
  ttftP90: number;
  avgLatency: number;
  tags: string[];
  history: HistoryBar[];
};

type ModelSummary = {
  successRate24h: number;
  availableModels: number;
  totalModels: number;
  activeUpstreams: number;
};

/**
 * Format numbers with M (millions) and B (billions).
 * Below 1M: format with commas (e.g. 500,000).
 * Null: "Unlimited".
 */
export function formatTokens(val: number | null | undefined): string {
  if (val === null || val === undefined) return "Unlimited";
  if (val >= 1_000_000_000) {
    const b = val / 1_000_000_000;
    return `${Number.isInteger(b) ? b : b.toFixed(1)}B`;
  }
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return val.toLocaleString();
}

/**
 * 1:1 Pixel-Perfect Confirmation Modal matching brain/image.png
 */
interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title: string;
  itemName: string;
  onConfirm: () => void;
  onClose: () => void;
  isLoading?: boolean;
}

function ConfirmDeleteModal({
  isOpen,
  title,
  itemName,
  onConfirm,
  onClose,
  isLoading,
}: ConfirmDeleteModalProps) {
  if (!isOpen) return null;

  return (
    <FloatingPortal id="portal-root">
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0">
        <div className="w-full max-w-[460px] rounded-[18px] border border-white/[0.08] bg-[#1c1c1f] p-6 shadow-2xl shadow-black/80 animate-in zoom-in-95 duration-150">
          <h3 className="text-xl font-bold tracking-tight text-white">{title}</h3>

          <p className="mt-3 text-sm text-[#a1a1aa] leading-relaxed">
            Apakah kamu yakin untuk menghapus <span className="font-bold text-white">{itemName}</span>?
            <br />
            Tindakan ini tidak dapat dibatalkan.
          </p>

          <div className="my-5 border-t border-white/[0.08]" />

          <div className="flex justify-end items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/[0.08] bg-[#141416] hover:bg-[#222226] px-5 py-2.5 text-sm font-medium text-white transition-colors"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={isLoading}
              onClick={onConfirm}
              className="rounded-xl bg-[#ff3b4e] hover:bg-[#eb2b3e] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors disabled:opacity-50"
            >
              {isLoading ? "Menghapus..." : "Hapus"}
            </button>
          </div>
        </div>
      </div>
    </FloatingPortal>
  );
}

/**
 * Headless Floating 3-Dot Dropdown Menu
 * Decoupled from parent DOM hierarchy via Portal into #portal-root
 * Strategy: fixed, with collision detection (flip, shift, offset) & autoUpdate (scroll/resize)
 */
interface KeyActionMenuProps {
  k: KeyItem;
  onTopup: () => void;
  onEdit: () => void;
  onRotate: () => void;
  onReset: () => void;
  onDelete: () => void;
}

function KeyActionMenu({ k, onTopup, onEdit, onRotate, onReset, onDelete }: KeyActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: "bottom-end",
    strategy: "fixed", // Viewport-relative coords, escapes any parent overflow/table constraints
    whileElementsMounted: autoUpdate, // Dynamic scroll and resize recalculation
    middleware: [
      offset(6),
      flip({ fallbackPlacements: ["top-end", "bottom-start", "top-start"] }),
      shift({ padding: 12 }),
    ],
  });

  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, { role: "menu" });

  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps({
          onClick: (e) => {
            e.stopPropagation();
            setIsOpen(!isOpen);
          },
        })}
        className="h-8 w-8 rounded-md border border-zinc-800 hover:border-zinc-700 bg-zinc-900 hover:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition-colors"
        aria-label="Actions"
      >
        <MoreHorizontal size={15} />
      </button>

      {isOpen && (
        <FloatingPortal id="portal-root">
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[9999] w-48 rounded-lg border border-zinc-800 bg-zinc-950/95 p-1 shadow-2xl backdrop-blur-md text-left animate-in fade-in-0 zoom-in-95"
          >
            <button
              onClick={() => {
                setIsOpen(false);
                onTopup();
              }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/80 transition-colors font-medium"
            >
              <Coins size={14} className="text-amber-400" />
              <span>Top Up Quota</span>
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                onEdit();
              }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/80 transition-colors font-medium"
            >
              <Pencil size={14} className="text-blue-400" />
              <span>Edit Key</span>
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                onRotate();
              }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/80 transition-colors font-medium"
            >
              <RefreshCw size={14} className="text-cyan-400" />
              <span>Rotate Secret</span>
            </button>

            <button
              onClick={() => {
                setIsOpen(false);
                onReset();
              }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800/80 transition-colors font-medium"
            >
              <RotateCcw size={14} className="text-zinc-400" />
              <span>Reset Used Tokens</span>
            </button>

            <div className="my-1 border-t border-zinc-800/80" />

            <button
              onClick={() => {
                setIsOpen(false);
                onDelete();
              }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/50 hover:text-red-300 transition-colors font-medium"
            >
              <Trash2 size={14} />
              <span>Delete Key</span>
            </button>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<"keys" | "upstreams" | "models" | "telemetry" | "admin">("keys");
  const [authStatus, setAuthStatus] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState("");
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [upstreams, setUpstreams] = useState<UpstreamItem[]>([]);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);

  // Model Management State (1:1 matching brain/image.png)
  const [modelsData, setModelsData] = useState<{ summary: ModelSummary; models: ModelManagementItem[] } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsSyncing, setModelsSyncing] = useState(false);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [modelsTimeWindow, setModelsTimeWindow] = useState<"24h" | "1h">("24h");
  const [modelSearch, setModelSearch] = useState("");
  const [modelProviderFilter, setModelProviderFilter] = useState("all");
  const [modelStatusFilter, setModelStatusFilter] = useState<"all" | "normal" | "demote" | "offline">("all");
  const [modelsPage, setModelsPage] = useState(1);
  const [stats, setStats] = useState<any>(null);
  const [activeRequests, setActiveRequests] = useState<number>(0);
  const [optimizations, setOptimizations] = useState<any>({});
  const [systemInfo, setSystemInfo] = useState<any>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Generate Key Modal State
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [genName, setGenName] = useState("");
  const [genUnlimited, setGenUnlimited] = useState(false);
  const [genTokens, setGenTokens] = useState<number>(50_000_000);

  // Top-up Modal State
  const [topupKey, setTopupKey] = useState<KeyItem | null>(null);
  const [topupAmount, setTopupAmount] = useState<number>(50_000_000);
  const [topupNote, setTopupNote] = useState("");

  // Edit Key Modal State
  const [editKeyItem, setEditKeyItem] = useState<KeyItem | null>(null);
  const [editName, setEditName] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);

  // 1:1 Confirm Delete Modal State
  const [deleteConfirm, setDeleteConfirm] = useState<{
    isOpen: boolean;
    type: "key" | "upstream";
    id: string;
    name: string;
  }>({
    isOpen: false,
    type: "key",
    id: "",
    name: "",
  });

  // Upstream Form State
  const [newUpstreamName, setNewUpstreamName] = useState("");
  const [newUpstreamProvider, setNewUpstreamProvider] = useState("openai");
  const [newUpstreamKey, setNewUpstreamKey] = useState("");

  // Provider registry from provider.json (via GET /api/providers/)
  const [providerPresets, setProviderPresets] = useState<ProviderPreset[]>([]);

  // Edit Upstream Modal State
  const [editUpstreamItem, setEditUpstreamItem] = useState<UpstreamItem | null>(null);
  const [editUpstreamName, setEditUpstreamName] = useState("");
  const [editUpstreamProvider, setEditUpstreamProvider] = useState("openai");
  const [editUpstreamBaseUrl, setEditUpstreamBaseUrl] = useState("");
  const [editUpstreamApiKey, setEditUpstreamApiKey] = useState("");
  const [editUpstreamIsActive, setEditUpstreamIsActive] = useState(true);
  const [editUpstreamKeyVisible, setEditUpstreamKeyVisible] = useState(false);
  const [editUpstreamUrlVisible, setEditUpstreamUrlVisible] = useState(false);

  const checkAuth = async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json();
      setAuthStatus(!!data.data?.authenticated);
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pinInput }),
      });
      const data = await res.json();
      if (data.success) {
        setAuthStatus(true);
        setPinInput("");
        loadAll();
      } else {
        alert(data.error || "Login failed");
      }
    } catch (e) {
      alert("Login error");
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthStatus(false);
  };

  const loadKeys = async () => {
    try {
      const res = await fetch("/api/keys/");
      const data = await res.json();
      if (data.success) setKeys(data.data);
    } catch (e) { }
  };

  const loadUpstreams = async () => {
    try {
      const res = await fetch("/api/upstreams/");
      const data = await res.json();
      if (data.success) setUpstreams(data.data);
    } catch (e) { }
  };

  const loadTelemetry = async () => {
    try {
      const [logsRes, statsRes, activeRes] = await Promise.all([
        fetch("/api/telemetry/logs?limit=25"),
        fetch("/api/telemetry/stats?hours=24"),
        fetch("/api/telemetry/active"),
      ]);
      const logsData = await logsRes.json();
      const statsData = await statsRes.json();
      const activeData = await activeRes.json();
      if (logsData.success) setTelemetryLogs(logsData.data.logs);
      if (statsData.success) setStats(statsData.data.stats);
      if (activeData.success) setActiveRequests(activeData.data.activeRequests);
    } catch (e) { }
  };

  const loadAdmin = async () => {
    try {
      const [optRes, sysRes] = await Promise.all([
        fetch("/api/admin/settings/optimizations"),
        fetch("/api/admin/system"),
      ]);
      const optData = await optRes.json();
      const sysData = await sysRes.json();
      if (optData.success) setOptimizations(optData.data);
      if (sysData.success) setSystemInfo(sysData.data);
    } catch (e) { }
  };

  const loadProviders = async () => {
    try {
      const res = await fetch("/api/providers/");
      const data = await res.json();
      if (data.success) setProviderPresets(data.data);
    } catch (e) { }
  };

  const loadModels = async (win = modelsTimeWindow) => {
    setModelsLoading(true);
    try {
      const res = await fetch(`/api/models/management?window=${win}`);
      const json = await res.json();
      if (json.data) setModelsData(json.data);
    } catch (e) { }
    finally {
      setModelsLoading(false);
    }
  };

  const testModel = async (upstreamId: string, modelId: string) => {
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstreamId, modelId }),
      });
      const data = await res.json();
      await loadModels(modelsTimeWindow);
      if (!data.data?.success && data.data?.error) {
        alert(`Test Response for ${modelId}:\nStatus: HTTP ${data.data?.statusCode} (${data.data?.latency_ms}ms)\n${data.data?.error}`);
      }
    } catch (e) {
      console.error("Test failed", e);
    } finally {
      setTestingModelId(null);
    }
  };

  const syncAllModels = async () => {
    setModelsSyncing(true);
    try {
      await fetch("/api/models/sync-all", { method: "POST" });
      await loadModels();
      await loadUpstreams();
    } catch (e) { }
    finally {
      setModelsSyncing(false);
    }
  };

  const toggleModelEnabled = async (upstreamId: string, modelId: string, currentEnabled: boolean) => {
    try {
      await fetch("/api/models/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upstreamId, modelId, enabled: !currentEnabled }),
      });
      setModelsData((prev) => {
        if (!prev) return null;
        const updated = prev.models.map((m) => {
          if (m.upstreamId === upstreamId && m.id === modelId) {
            const nextEnabled = !currentEnabled;
            return {
              ...m,
              enabled: nextEnabled,
              status: !nextEnabled ? ("offline" as const) : m.status === "offline" ? ("normal" as const) : m.status,
            };
          }
          return m;
        });
        const available = updated.filter((m) => m.enabled && m.upstreamActive).length;
        return {
          ...prev,
          summary: { ...prev.summary, availableModels: available },
          models: updated,
        };
      });
    } catch (e) { }
  };

  const loadAll = () => {
    loadKeys();
    loadUpstreams();
    loadModels();
    loadTelemetry();
    loadAdmin();
    loadProviders();
  };

  useEffect(() => {
    checkAuth();
    loadAll();
    const interval = setInterval(loadTelemetry, 10000);
    return () => clearInterval(interval);
  }, []);

  // Submit Generate Key
  const handleGenerateKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genName.trim()) return;
    setLoading(true);
    const tokenLimit = genUnlimited ? null : genTokens;
    await fetch("/api/keys/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: genName.trim(), tokenLimit }),
    });
    setGenName("");
    setGenTokens(50_000_000);
    setGenUnlimited(false);
    setShowGenerateModal(false);
    setLoading(false);
    loadKeys();
  };

  // Submit Top-up
  const handleTopupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topupKey) return;
    if (!topupAmount || topupAmount <= 0) return alert("Enter a valid positive token count");

    setLoading(true);
    const res = await fetch(`/api/keys/${topupKey.id}/topup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: topupAmount, note: topupNote }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.success) {
      setTopupKey(null);
      setTopupNote("");
      loadKeys();
    } else {
      alert(`Top-up failed: ${data.error}`);
    }
  };

  // Submit Edit Key
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editKeyItem) return;
    setLoading(true);
    await fetch(`/api/keys/${editKeyItem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName.trim(),
        isActive: editIsActive,
      }),
    });
    setEditKeyItem(null);
    setLoading(false);
    loadKeys();
  };

  // Manual Base URL override normalization: "x.y/v1" -> "https://x.y"
  const normalizeBaseUrl = (v: string) => {
    let u = v.trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    return u.replace(/\/v1\/?$/i, "").replace(/\/$/, "") || null;
  };

  const openEditUpstreamModal = (u: UpstreamItem) => {
    setEditUpstreamItem(u);
    setEditUpstreamName(u.name);
    setEditUpstreamProvider(u.provider);
    setEditUpstreamBaseUrl(u.baseUrl || "");
    const savedKey = u.keys?.find((k) => k.isActive)?.key ?? u.keys?.[0]?.key ?? "";
    setEditUpstreamApiKey(savedKey);
    setEditUpstreamIsActive(u.isActive);
    setEditUpstreamKeyVisible(false);
    setEditUpstreamUrlVisible(false);
  };

  const handleEditUpstreamSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUpstreamItem) return;
    setLoading(true);
    const payload: any = {
      name: editUpstreamName.trim(),
      provider: editUpstreamProvider.trim() || editUpstreamItem.provider,
      isActive: editUpstreamIsActive,
    };
    if (editUpstreamBaseUrl.trim()) payload.baseUrl = normalizeBaseUrl(editUpstreamBaseUrl);
    else if (editUpstreamItem.baseUrl) payload.baseUrl = null;
    const originalKey = editUpstreamItem.keys?.find((k) => k.isActive)?.key ?? editUpstreamItem.keys?.[0]?.key ?? "";
    if (editUpstreamApiKey.trim() && editUpstreamApiKey.trim() !== originalKey) {
      payload.apiKey = editUpstreamApiKey.trim();
    }
    await fetch(`/api/upstreams/${editUpstreamItem.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setEditUpstreamItem(null);
    setLoading(false);
    loadUpstreams();
  };

  // Trigger 1:1 delete confirmation modal for key
  const requestDeleteKey = (k: KeyItem) => {
    setDeleteConfirm({
      isOpen: true,
      type: "key",
      id: k.id,
      name: k.name,
    });
  };

  // Trigger 1:1 delete confirmation modal for upstream
  const requestDeleteUpstream = (u: UpstreamItem) => {
    setDeleteConfirm({
      isOpen: true,
      type: "upstream",
      id: u.id,
      name: u.name,
    });
  };

  // Execute confirmed deletion
  const handleExecuteDelete = async () => {
    setLoading(true);
    if (deleteConfirm.type === "key") {
      await fetch(`/api/keys/${deleteConfirm.id}`, { method: "DELETE" });
      loadKeys();
    } else if (deleteConfirm.type === "upstream") {
      await fetch(`/api/upstreams/${deleteConfirm.id}`, { method: "DELETE" });
      loadUpstreams();
    }
    setLoading(false);
    setDeleteConfirm({ isOpen: false, type: "key", id: "", name: "" });
  };

  const rotateKey = async (id: string) => {
    await fetch(`/api/keys/${id}/rotate`, { method: "POST" });
    loadKeys();
  };

  const resetQuota = async (id: string) => {
    await fetch(`/api/keys/${id}/reset-quota`, { method: "POST" });
    loadKeys();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(text);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Upstream actions
  const createUpstream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUpstreamName.trim() || !newUpstreamKey.trim()) return;
    setLoading(true);
    await fetch("/api/upstreams/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newUpstreamName.trim(),
        provider: newUpstreamProvider || "openai",
        apiKey: newUpstreamKey.trim(),
      }),
    });
    setNewUpstreamName("");
    setNewUpstreamKey("");
    setLoading(false);
    loadUpstreams();
  };

  const testUpstream = async (id: string) => {
    const res = await fetch(`/api/upstreams/${id}/test`, { method: "POST" });
    const data = await res.json();
    alert(data.data?.ok ? "Upstream test passed!" : `Test failed: ${JSON.stringify(data.data)}`);
  };

  const fetchModels = async (id: string) => {
    const res = await fetch(`/api/upstreams/${id}/fetch-models`, { method: "POST" });
    const data = await res.json();
    alert(`Fetched ${data.data?.models?.length || 0} models`);
    loadUpstreams();
  };

  const toggleOptimization = async (key: string, val: boolean) => {
    const next = { ...optimizations, [key]: val };
    setOptimizations(next);
    await fetch("/api/admin/settings/optimizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: val }),
    });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/*  1:1 CONFIRMATION MODAL (MATCHING brain/image.png) ─ */}
      <ConfirmDeleteModal
        isOpen={deleteConfirm.isOpen}
        title={deleteConfirm.type === "key" ? "Hapus Client Key" : "Hapus Upstream Provider"}
        itemName={deleteConfirm.name}
        isLoading={loading}
        onClose={() => setDeleteConfirm({ isOpen: false, type: "key", id: "", name: "" })}
        onConfirm={handleExecuteDelete}
      />

      {/*  MODAL: GENERATE CLIENT KEY (PORTALED)  */}
      {showGenerateModal && (
        <FloatingPortal id="portal-root">
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0">
            <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-100">
                    <Key size={16} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">Generate Client Key</h3>
                    <p className="text-xs text-zinc-400">Issue commercial API key with token allocation</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowGenerateModal(false)}
                  className="text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleGenerateKeySubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Client / Application Name
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Acme Corp / Production Web"
                    value={genName}
                    onChange={(e) => setGenName(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>

                {/* Unlimited Tokens Checkbox */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genUnlimited}
                      onChange={(e) => setGenUnlimited(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-zinc-100 accent-zinc-100 focus:ring-0"
                    />
                    <div>
                      <span className="text-sm font-medium text-zinc-200">Unlimited Tokens</span>
                      <p className="text-xs text-zinc-400">No token quota limits will be enforced on this key.</p>
                    </div>
                  </label>
                </div>

                {/* Allocation Tokens (if not unlimited) */}
                {!genUnlimited && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-300">
                        Token Allocation
                      </label>
                      <span className="text-xs font-semibold text-emerald-400 bg-emerald-950/80 border border-emerald-800 px-2 py-0.5 rounded">
                        {formatTokens(genTokens)} Tokens
                      </span>
                    </div>

                    {/* Quick Select Chips */}
                    <div className="grid grid-cols-5 gap-1.5">
                      {[
                        { label: "10M", val: 10_000_000 },
                        { label: "25M", val: 25_000_000 },
                        { label: "50M", val: 50_000_000 },
                        { label: "100M", val: 100_000_000 },
                        { label: "1B", val: 1_000_000_000 },
                      ].map((chip) => (
                        <button
                          key={chip.label}
                          type="button"
                          onClick={() => setGenTokens(chip.val)}
                          className={`rounded-md border py-1.5 text-xs font-medium transition-colors ${genTokens === chip.val
                            ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                            : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                            }`}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>

                    <input
                      type="number"
                      min="1"
                      value={genTokens}
                      onChange={(e) => setGenTokens(parseInt(e.target.value) || 0)}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                    />
                    <p className="text-[11px] text-zinc-500 font-mono">
                      Raw: {genTokens.toLocaleString()} tokens
                    </p>
                  </div>
                )}

                <div className="flex justify-end gap-2.5 pt-3 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setShowGenerateModal(false)}
                    className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-md bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-200 transition-colors"
                  >
                    {loading ? "Generating..." : "Generate Key"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </FloatingPortal>
      )}

      {/*  MODAL: TOP UP QUOTA (PORTALED) ─ */}
      {topupKey && (
        <FloatingPortal id="portal-root">
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0">
            <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-lg bg-amber-950/80 border border-amber-800/80 flex items-center justify-center text-amber-400">
                    <Coins size={16} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">Top Up Quota</h3>
                    <p className="text-xs text-zinc-400">Add tokens to: <span className="text-zinc-200 font-medium">{topupKey.name}</span></p>
                  </div>
                </div>
                <button
                  onClick={() => setTopupKey(null)}
                  className="text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Quota Summary Box */}
              <div className="my-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 space-y-2 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-sans">Current Limit:</span>
                  <span className="font-semibold text-zinc-200">{formatTokens(topupKey.tokenLimit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-sans">Used Tokens:</span>
                  <span className="text-amber-400 font-semibold">{formatTokens(topupKey.usedTokens)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400 font-sans">Remaining:</span>
                  <span className={`font-semibold ${topupKey.quotaExhausted ? "text-red-400" : "text-emerald-400"}`}>
                    {formatTokens(topupKey.remainingTokens)}
                  </span>
                </div>
                <div className="border-t border-zinc-800 pt-2 flex justify-between text-zinc-100 font-semibold">
                  <span className="font-sans text-zinc-300">Projected New Limit:</span>
                  <span className="text-cyan-400">{formatTokens((topupKey.tokenLimit ?? 0) + (topupAmount || 0))}</span>
                </div>
              </div>

              <form onSubmit={handleTopupSubmit} className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-zinc-300">
                      Tokens to Add (+)
                    </label>
                    <span className="text-xs font-semibold text-amber-400">
                      +{formatTokens(topupAmount)}
                    </span>
                  </div>

                  {/* Quick Chips */}
                  <div className="grid grid-cols-5 gap-1.5 mb-2">
                    {[
                      { label: "10M", val: 10_000_000 },
                      { label: "25M", val: 25_000_000 },
                      { label: "50M", val: 50_000_000 },
                      { label: "100M", val: 100_000_000 },
                      { label: "1B", val: 1_000_000_000 },
                    ].map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={() => setTopupAmount(chip.val)}
                        className={`rounded-md border py-1.5 text-xs font-medium transition-colors ${topupAmount === chip.val
                          ? "border-amber-500 bg-amber-950/60 text-amber-300"
                          : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          }`}
                      >
                        +{chip.label}
                      </button>
                    ))}
                  </div>

                  <input
                    type="number"
                    min="1"
                    required
                    value={topupAmount}
                    onChange={(e) => setTopupAmount(parseInt(e.target.value) || 0)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Invoice / Reference Note (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Stripe #ch_123, Order #882"
                    value={topupNote}
                    onChange={(e) => setTopupNote(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>

                <div className="flex justify-end gap-2.5 pt-3 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setTopupKey(null)}
                    className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-md bg-amber-500 hover:bg-amber-400 px-4 py-2 text-xs font-semibold text-zinc-950 transition-colors"
                  >
                    {loading ? "Adding Quota..." : "Confirm Top Up"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </FloatingPortal>
      )}

      {/*  MODAL: EDIT KEY (PORTALED) ─ */}
      {editKeyItem && (
        <FloatingPortal id="portal-root">
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0">
            <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-100">
                    <Pencil size={15} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">Edit Client Key</h3>
                    <p className="text-xs text-zinc-400">Update client metadata and status</p>
                  </div>
                </div>
                <button
                  onClick={() => setEditKeyItem(null)}
                  className="text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Client / Key Name
                  </label>
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-sm font-medium text-zinc-200">Active Status</span>
                      <p className="text-xs text-zinc-400">Deactivated keys are blocked at gateway.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={editIsActive}
                      onChange={(e) => setEditIsActive(e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-zinc-100 accent-zinc-100"
                    />
                  </label>
                </div>

                <div className="flex justify-end gap-2.5 pt-3 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setEditKeyItem(null)}
                    className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-md bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-200 transition-colors"
                  >
                    Save Changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        </FloatingPortal>
      )}

      {/*  MODAL: EDIT UPSTREAM PROVIDER (PORTALED)  */}
      {editUpstreamItem && (
        <FloatingPortal id="portal-root">
          <div className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in-0">
            <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
              <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <div className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-100">
                    <Pencil size={15} />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-zinc-100">Edit Upstream Provider</h3>
                    <p className="text-xs text-zinc-400">Update provider connection details</p>
                  </div>
                </div>
                <button
                  onClick={() => setEditUpstreamItem(null)}
                  className="text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleEditUpstreamSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Provider Name
                  </label>
                  <input
                    type="text"
                    required
                    value={editUpstreamName}
                    onChange={(e) => setEditUpstreamName(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Provider
                  </label>
                  <select
                    value={editUpstreamProvider}
                    onChange={(e) => setEditUpstreamProvider(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  >
                    {providerPresets.length === 0 && (
                      <>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                      </>
                    )}
                    {providerPresets.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.label || p.provider}
                      </option>
                    ))}
                    {providerPresets.length > 0 &&
                      providerPresets.every((p) => p.provider !== editUpstreamProvider) && (
                        <option value={editUpstreamProvider}>{editUpstreamProvider}</option>
                      )}
                  </select>
                  <p className="text-[11px] text-zinc-500 mt-1.5">
                    Options come from provider.json. Endpoint resolved from config unless Base URL override set.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Base URL
                  </label>
                  <div className="relative">
                    <input
                      type={editUpstreamUrlVisible ? "text" : "password"}
                      value={editUpstreamBaseUrl}
                      onChange={(e) => setEditUpstreamBaseUrl(e.target.value)}
                      placeholder="No saved base URL — uses official default"
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-9 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setEditUpstreamUrlVisible((v) => !v)}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      {editUpstreamUrlVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    API Key
                  </label>
                  <div className="relative">
                    <input
                      type={editUpstreamKeyVisible ? "text" : "password"}
                      value={editUpstreamApiKey}
                      onChange={(e) => setEditUpstreamApiKey(e.target.value)}
                      placeholder="No saved API key"
                      autoComplete="new-password"
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-9 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setEditUpstreamKeyVisible((v) => !v)}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 transition-colors"
                    >
                      {editUpstreamKeyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1.5">
                    Saved key shown masked. Toggle the eye icon to reveal. Editing it replaces the active upstream key.
                  </p>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-sm font-medium text-zinc-200">Active Status</span>
                      <p className="text-xs text-zinc-400">Inactive providers are skipped by the router.</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={editUpstreamIsActive}
                      onChange={(e) => setEditUpstreamIsActive(e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-zinc-100 accent-zinc-100"
                    />
                  </label>
                </div>

                <div className="flex justify-end gap-2.5 pt-3 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setEditUpstreamItem(null)}
                    className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-md bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 hover:bg-zinc-200 transition-colors"
                  >
                    Save Changes
                  </button>
                </div>
              </form>
            </div>
          </div>
        </FloatingPortal>
      )}

      {/*  TOP NAVBAR ─ */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-zinc-100 flex items-center justify-center text-zinc-950 font-bold shadow-sm">
            <Zap size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold tracking-tight text-sm text-zinc-100">Rizuu-Router</span>
              <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                Gateway
              </span>
            </div>
            <p className="text-xs text-zinc-400">Ultra-low latency AI Gateway & Commercial Quota Router</p>
          </div>
        </div>

        {/* Right side stats & auth */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-xs font-medium text-zinc-300">
            <span
              className={`h-2 w-2 rounded-full ${activeRequests > 0 ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`}
            />
            <span>{activeRequests} Active Calls</span>
          </div>

          <a
            href="/swagger"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100 px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 transition-colors"
          >
            <Terminal size={13} />
            <span>API Docs</span>
            <ExternalLink size={11} className="text-zinc-500" />
          </a>

          {authStatus ? (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 border border-red-950 bg-red-950/40 hover:bg-red-950/70 px-3 py-1.5 rounded-md transition-colors"
            >
              <LogOut size={13} />
              <span>Exit</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                placeholder="Admin PIN"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                className="w-24 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              />
              <button
                onClick={handleLogin}
                className="rounded-md bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-900 hover:bg-zinc-200 transition-colors"
              >
                Login
              </button>
            </div>
          )}
        </div>
      </header>

      {/*  MAIN LAYOUT ─ */}
      <div className="flex flex-1">
        {/* Sidebar */}
        <aside className="w-60 border-r border-zinc-800/80 bg-zinc-950 p-4 space-y-1.5 flex flex-col">
          <div className="px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
            Navigation
          </div>

          <button
            onClick={() => setActiveTab("keys")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === "keys"
              ? "bg-zinc-800 text-zinc-100 font-semibold"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
          >
            <Key size={15} />
            <span>Client Keys & Quotas</span>
          </button>

          <button
            onClick={() => setActiveTab("upstreams")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === "upstreams"
              ? "bg-zinc-800 text-zinc-100 font-semibold"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
          >
            <Layers size={15} />
            <span>AI Upstreams</span>
          </button>

          <button
            onClick={() => {
              setActiveTab("models");
              loadModels();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === "models"
              ? "bg-zinc-800 text-zinc-100 font-semibold"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
          >
            <Boxes size={15} />
            <span>Model Management</span>
          </button>

          <button
            onClick={() => setActiveTab("telemetry")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === "telemetry"
              ? "bg-zinc-800 text-zinc-100 font-semibold"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
          >
            <Activity size={15} />
            <span>Telemetry & Logs</span>
          </button>

          <button
            onClick={() => setActiveTab("admin")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${activeTab === "admin"
              ? "bg-zinc-800 text-zinc-100 font-semibold"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
          >
            <Sliders size={15} />
            <span>Engine Settings</span>
          </button>
        </aside>

        {/* Content Area */}
        <main className="flex-1 p-8 overflow-y-auto">
          {/*  TAB 1: CLIENT KEYS & COMMERCIAL QUOTAS  */}
          {activeTab === "keys" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-zinc-100">
                    Client Keys & Commercial Quotas
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    Allocate token quotas to paid keys. When tokens exhaust, proxy returns 402 Payment Required.
                  </p>
                </div>

                {/* Primary Button opens Modal */}
                <button
                  onClick={() => setShowGenerateModal(true)}
                  className="flex items-center gap-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-900 px-4 py-2 text-xs font-semibold shadow-sm transition-colors"
                >
                  <Plus size={15} />
                  <span>Generate Key</span>
                </button>
              </div>

              {/* Keys Table Card */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 shadow-sm overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800/80 bg-zinc-900/80 text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                      <th className="py-3 px-4">Client / Key</th>
                      <th className="py-3 px-4">Secret Key</th>
                      <th className="py-3 px-4">Quota Progress</th>
                      <th className="py-3 px-4">Remaining</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 text-xs">
                    {keys.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-zinc-500">
                          No client keys generated yet. Click "Generate Key" above to allocate your first commercial quota.
                        </td>
                      </tr>
                    ) : (
                      keys.map((k) => {
                        const percent =
                          k.tokenLimit && k.tokenLimit > 0
                            ? Math.min(100, Math.round((k.usedTokens / k.tokenLimit) * 100))
                            : 0;

                        return (
                          <tr key={k.id} className="hover:bg-zinc-800/30 transition-colors">
                            <td className="py-3 px-4">
                              <div className="font-semibold text-zinc-200">{k.name}</div>
                              <div className="text-[11px] text-zinc-500 font-mono mt-0.5">{k.createdAt}</div>
                            </td>

                            <td className="py-3 px-4">
                              <div className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/80 px-2 py-1 font-mono text-xs text-zinc-300">
                                <span>{k.key}</span>
                                <button
                                  onClick={() => copyToClipboard(k.key)}
                                  className="text-zinc-500 hover:text-zinc-200 transition-colors"
                                >
                                  {copiedKey === k.key ? (
                                    <Check size={13} className="text-emerald-400" />
                                  ) : (
                                    <Copy size={13} />
                                  )}
                                </button>
                              </div>
                            </td>

                            <td className="py-3 px-4 min-w-[190px]">
                              <div className="flex justify-between text-[11px] font-mono mb-1 text-zinc-400">
                                <span className="text-zinc-300 font-semibold">{formatTokens(k.usedTokens)}</span>
                                <span className="text-zinc-500">/ {formatTokens(k.tokenLimit)}</span>
                              </div>
                              {k.tokenLimit ? (
                                <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all duration-300 ${k.quotaExhausted
                                      ? "bg-red-500"
                                      : percent > 80
                                        ? "bg-amber-400"
                                        : "bg-emerald-400"
                                      }`}
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                              ) : (
                                <span className="text-[11px] text-zinc-500 font-mono">No Limit</span>
                              )}
                            </td>

                            <td className="py-3 px-4 font-mono font-semibold">
                              {k.remainingTokens !== null ? (
                                <span className={k.quotaExhausted ? "text-red-400" : "text-emerald-400"}>
                                  {formatTokens(k.remainingTokens)}
                                </span>
                              ) : (
                                <span className="text-zinc-400">Unlimited</span>
                              )}
                            </td>

                            <td className="py-3 px-4">
                              {k.quotaExhausted ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-red-800/80 bg-red-950/60 px-2.5 py-0.5 text-[10px] font-semibold text-red-300">
                                  <AlertTriangle size={10} /> Exhausted
                                </span>
                              ) : percent > 80 ? (
                                <span className="inline-flex items-center rounded-full border border-amber-800/80 bg-amber-950/60 px-2.5 py-0.5 text-[10px] font-semibold text-amber-300">
                                  Low Quota
                                </span>
                              ) : !k.isActive ? (
                                <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                                  Inactive
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800/80 bg-emerald-950/60 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-300">
                                  <CheckCircle2 size={10} /> Active
                                </span>
                              )}
                            </td>

                            {/*  ROBUST HEADLESS PORTAL 3-DOT MENU ─ */}
                            <td className="py-3 px-4 text-right">
                              <KeyActionMenu
                                k={k}
                                onTopup={() => {
                                  setTopupKey(k);
                                  setTopupAmount(50_000_000);
                                }}
                                onEdit={() => {
                                  setEditKeyItem(k);
                                  setEditName(k.name);
                                  setEditIsActive(k.isActive);
                                }}
                                onRotate={() => rotateKey(k.id)}
                                onReset={() => resetQuota(k.id)}
                                onDelete={() => requestDeleteKey(k)}
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/*  TAB 2: UPSTREAMS ─ */}
          {activeTab === "upstreams" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-zinc-100">
                  AI Upstream Providers
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Configure upstream LLM providers (OpenAI, Anthropic, Custom endpoints).
                </p>
              </div>

              {/* Provider Registry (from provider.json) */}
              {providerPresets.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-zinc-200">Provider Registry</h3>
                    <span className="text-[10px] font-mono text-zinc-500">provider.json • {providerPresets.length} entries • hot-reload</span>
                  </div>
                  <div className="grid gap-2">
                    {providerPresets.map((p) => (
                      <div
                        key={p.provider}
                        className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2"
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${p.provider === "openai"
                              ? "border-blue-800 bg-blue-950/70 text-blue-300"
                              : p.provider === "anthropic"
                                ? "border-purple-800 bg-purple-950/70 text-purple-300"
                                : "border-amber-800 bg-amber-950/70 text-amber-300"
                              }`}
                          >
                            {p.provider}
                          </span>
                          <span className="text-xs font-medium text-zinc-300">{p.label || p.provider}</span>
                        </div>
                        <span className="text-xs text-zinc-500 font-mono truncate max-w-[50%]">{p.endpoint}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add Upstream Card */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-zinc-200 mb-3">Add Upstream Provider</h3>
                <form onSubmit={createUpstream} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <input
                    type="text"
                    required
                    placeholder="Upstream Name (e.g. OpenAI Prod)"
                    value={newUpstreamName}
                    onChange={(e) => setNewUpstreamName(e.target.value)}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                  <select
                    value={newUpstreamProvider}
                    onChange={(e) => setNewUpstreamProvider(e.target.value)}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  >
                    {providerPresets.length === 0 && (
                      <>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                      </>
                    )}
                    {providerPresets.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.label || p.provider}
                      </option>
                    ))}
                  </select>
                  <input
                    type="password"
                    required
                    placeholder="API Key (sk-...)"
                    value={newUpstreamKey}
                    onChange={(e) => setNewUpstreamKey(e.target.value)}
                    className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-400"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="rounded-md bg-zinc-100 hover:bg-zinc-200 text-zinc-900 px-4 py-2 text-xs font-semibold shadow-sm transition-colors"
                  >
                    Add Provider
                  </button>
                </form>
              </div>

              {/* Upstreams List */}
              <div className="grid gap-3">
                {upstreams.map((u) => (
                  <div
                    key={u.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-2.5">
                        <span className="font-semibold text-sm text-zinc-200">{u.name}</span>
                        <span
                          className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${u.provider === "openai"
                            ? "border-blue-800 bg-blue-950/70 text-blue-300"
                            : u.provider === "anthropic"
                              ? "border-purple-800 bg-purple-950/70 text-purple-300"
                              : "border-amber-800 bg-amber-950/70 text-amber-300"
                            }`}
                        >
                          {u.provider}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 font-mono mt-1">
                        Base: {u.baseUrl || "Default Official"} • {u.keys?.length || 0} Keys • {u.models?.length || 0} Models
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => testUpstream(u.id)}
                        className="rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-cyan-400 transition-colors"
                      >
                        Test
                      </button>
                      <button
                        onClick={() => fetchModels(u.id)}
                        className="rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 text-xs font-medium text-purple-400 transition-colors"
                      >
                        Sync Models
                      </button>
                      <button
                        onClick={() => openEditUpstreamModal(u)}
                        className="h-8 w-8 rounded-md border border-zinc-800 hover:border-zinc-600 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 flex items-center justify-center transition-colors"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => requestDeleteUpstream(u)}
                        className="h-8 w-8 rounded-md border border-zinc-800 hover:border-red-900 bg-zinc-900 hover:bg-red-950/50 text-zinc-400 hover:text-red-400 flex items-center justify-center transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/*  TAB: MODEL MANAGEMENT (1:1 matching brain/image.png)  */}
          {activeTab === "models" && (
            <div className="space-y-6">
              {/* Header Title */}
              <div>
                <h2 className="text-xl font-bold tracking-tight text-zinc-100">
                  Model Management & Status
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Real-time health monitoring, availability history, and latency tracking for synced AI models.
                </p>
              </div>

              {/* Top Stat Cards matching brain/image.png */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-white/[0.08] bg-[#121316] p-5 shadow-sm">
                  <div className="text-xs font-normal text-[#a1a1aa]">Success rate (24h)</div>
                  <div className="mt-1.5 text-3xl font-bold tracking-tight text-white">
                    {modelsData?.summary?.successRate24h !== undefined ? `${modelsData.summary.successRate24h}%` : "95.94%"}
                  </div>
                </div>
                <div className="rounded-xl border border-white/[0.08] bg-[#121316] p-5 shadow-sm">
                  <div className="text-xs font-normal text-[#a1a1aa]">Available models</div>
                  <div className="mt-1.5 text-3xl font-bold tracking-tight text-white">
                    {modelsData?.summary ? `${modelsData.summary.availableModels} / ${modelsData.summary.totalModels}` : "0 / 0"}
                  </div>
                </div>
              </div>

              {/* Filters & Actions Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#121316] p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="text"
                      placeholder="Filter models by id or name..."
                      value={modelSearch}
                      onChange={(e) => {
                        setModelSearch(e.target.value);
                        setModelsPage(1);
                      }}
                      className="w-full rounded-lg border border-zinc-800 bg-[#0d0e11] pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600"
                    />
                  </div>

                  {/* Provider filter */}
                  <select
                    value={modelProviderFilter}
                    onChange={(e) => {
                      setModelProviderFilter(e.target.value);
                      setModelsPage(1);
                    }}
                    className="rounded-lg border border-zinc-800 bg-[#0d0e11] px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-zinc-600"
                  >
                    <option value="all">All Upstreams</option>
                    {upstreams.map((u) => (
                      <option key={u.id} value={u.name}>
                        {u.name} ({u.provider})
                      </option>
                    ))}
                  </select>

                  {/* Status filter tabs */}
                  <div className="flex items-center bg-[#0d0e11] rounded-lg border border-zinc-800 p-0.5 text-xs">
                    {(["all", "normal", "demote", "offline"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => {
                          setModelStatusFilter(s);
                          setModelsPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-md capitalize font-medium transition-colors ${modelStatusFilter === s
                            ? "bg-zinc-800 text-white"
                            : "text-zinc-400 hover:text-zinc-200"
                          }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {/* Time Window (24h / 1h) */}
                  <div className="flex items-center bg-[#0d0e11] rounded-lg border border-zinc-800 p-0.5 text-xs">
                    <button
                      onClick={() => {
                        setModelsTimeWindow("24h");
                        loadModels("24h");
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${modelsTimeWindow === "24h"
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:text-zinc-200"
                        }`}
                    >
                      24h Window
                    </button>
                    <button
                      onClick={() => {
                        setModelsTimeWindow("1h");
                        loadModels("1h");
                      }}
                      className={`px-2.5 py-1 rounded-md font-medium transition-colors ${modelsTimeWindow === "1h"
                          ? "bg-zinc-800 text-white"
                          : "text-zinc-400 hover:text-zinc-200"
                        }`}
                    >
                      1h Live
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={syncAllModels}
                    disabled={modelsSyncing}
                    className="flex items-center gap-1.5 rounded-lg border border-purple-800/70 bg-purple-950/40 hover:bg-purple-900/40 text-purple-300 px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={modelsSyncing ? "animate-spin" : ""} />
                    <span>{modelsSyncing ? "Syncing..." : "Sync All Models"}</span>
                  </button>

                  <button
                    onClick={() => loadModels(modelsTimeWindow)}
                    disabled={modelsLoading}
                    className="h-8 w-8 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
                    title="Refresh model metrics"
                  >
                    <RefreshCw size={13} className={modelsLoading ? "animate-spin" : ""} />
                  </button>
                </div>
              </div>

              {/* Models List */}
              {(() => {
                const filteredModels = (modelsData?.models || []).filter((m) => {
                  if (modelSearch.trim()) {
                    const q = modelSearch.toLowerCase();
                    if (
                      !m.id.toLowerCase().includes(q) &&
                      !m.name.toLowerCase().includes(q) &&
                      !m.upstreamName.toLowerCase().includes(q)
                    ) {
                      return false;
                    }
                  }
                  if (modelProviderFilter !== "all" && m.upstreamName !== modelProviderFilter) {
                    return false;
                  }
                  if (modelStatusFilter !== "all" && m.status !== modelStatusFilter) {
                    return false;
                  }
                  return true;
                });

                const totalPages = Math.ceil(filteredModels.length / 15) || 1;
                const paginatedModels = filteredModels.slice((modelsPage - 1) * 15, modelsPage * 15);

                if (filteredModels.length === 0) {
                  return (
                    <div className="rounded-xl border border-white/[0.08] bg-[#121316] p-12 text-center">
                      <Boxes size={32} className="mx-auto text-zinc-600 mb-3" />
                      <p className="text-sm font-medium text-zinc-300">No synced models match the filters</p>
                      <p className="text-xs text-zinc-500 mt-1">
                        Try clearing search query or click "Sync All Models" to discover models from active upstreams.
                      </p>
                      <button
                        onClick={syncAllModels}
                        className="mt-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 px-4 py-2 text-xs font-semibold text-zinc-100 transition-colors"
                      >
                        Sync Models Now
                      </button>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {paginatedModels.map((m) => (
                      <div
                        key={`${m.upstreamId}-${m.id}`}
                        className="rounded-xl border border-white/[0.08] bg-[#121316] p-4 space-y-3.5 hover:border-zinc-700/80 transition-all shadow-sm"
                      >
                        {/* Top row: Status dot, Name, Badges, Stats */}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {/* Left side */}
                          <div className="flex items-center gap-2.5 flex-wrap">
                            {/* Status Dot */}
                            <span
                              className={`h-2.5 w-2.5 rounded-full shrink-0 ${m.status === "normal"
                                  ? "bg-[#10b981] shadow-[0_0_8px_rgba(16,185,129,0.8)]"
                                  : m.status === "demote"
                                    ? "bg-[#f97316] shadow-[0_0_8px_rgba(249,115,22,0.8)]"
                                    : "bg-zinc-600"
                                }`}
                            />

                            {/* Model Name */}
                            <span className="font-bold text-sm text-white tracking-tight font-sans">
                              {m.name || m.id}
                            </span>

                            {/* Status Badge */}
                            {m.status === "normal" && (
                              <span className="text-[11px] font-medium px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                                Normal
                              </span>
                            )}
                            {m.status === "demote" && (
                              <span className="text-[11px] font-medium px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">
                                Demote
                              </span>
                            )}
                            {m.status === "offline" && (
                              <span className="text-[11px] font-medium px-2 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-400">
                                Disabled
                              </span>
                            )}

                            {/* Tags: chat, responses, claude_native */}
                            {m.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#27272a] text-[#d4d4d8] border border-white/[0.04]"
                              >
                                {tag}
                              </span>
                            ))}

                            {/* Upstream source */}
                            <span className="text-[10px] text-zinc-500 font-mono">
                              {m.upstreamName}
                            </span>
                          </div>

                          {/* Right side stats */}
                          <div className="flex items-center gap-4 text-xs">
                            <div className="text-zinc-400">
                              Availability:{" "}
                              <span className="font-semibold text-zinc-200">{m.availability}%</span>
                            </div>
                            <div className="text-zinc-400">
                              TTFT P90:{" "}
                              <span className="font-semibold text-zinc-200">{m.ttftP90} ms</span>
                            </div>
                            <div className="text-zinc-400">
                              Avg latency:{" "}
                              <span className="font-semibold text-zinc-200">{m.avgLatency} ms</span>
                            </div>

                            {/* Live Ping Test Button */}
                            <button
                              onClick={() => testModel(m.upstreamId, m.id)}
                              disabled={testingModelId === m.id || !m.enabled}
                              className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded bg-zinc-800/90 hover:bg-zinc-700 text-cyan-400 hover:text-cyan-300 border border-zinc-700/50 disabled:opacity-40 transition-colors"
                              title="Send live request to test model and record real telemetry"
                            >
                              <Zap size={11} className={testingModelId === m.id ? "animate-pulse" : ""} />
                              <span>{testingModelId === m.id ? "Pinging..." : "Ping"}</span>
                            </button>

                            {/* Quick enable/disable toggle */}
                            <button
                              onClick={() => toggleModelEnabled(m.upstreamId, m.id, m.enabled)}
                              className={`text-[11px] font-medium px-2.5 py-1 rounded transition-colors ${m.enabled
                                  ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                                  : "bg-red-950/60 hover:bg-red-900/60 text-red-400 border border-red-900/60"
                                }`}
                              title={m.enabled ? "Click to disable this model" : "Click to enable this model"}
                            >
                              {m.enabled ? "Active" : "Disabled"}
                            </button>
                          </div>
                        </div>

                        {/* Status History Bar Chart (matching brain/image.png) */}
                        <div className="flex items-center gap-[2.5px] w-full pt-1">
                          {m.history.map((bar, i) => {
                            let bg = "bg-[#3f3f46]/50";
                            if (bar.status === "warning") bg = "bg-[#f59e0b]";
                            else if (bar.status === "success") bg = "bg-[#22c55e]";
                            else if (bar.status === "error") bg = "bg-[#ef4444]";

                            return (
                              <div
                                key={i}
                                className={`flex-1 h-5 rounded-[2px] ${bg} transition-all hover:scale-y-125 hover:brightness-125 cursor-pointer`}
                                title={
                                  bar.requests > 0
                                    ? `${bar.time}: ${bar.requests} reqs (${bar.latency}ms avg) • ${bar.status.toUpperCase()}`
                                    : `${bar.time}: No requests (Idle)`
                                }
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between pt-4 border-t border-zinc-800/80 text-xs text-zinc-400">
                        <div>
                          Showing {(modelsPage - 1) * 15 + 1} -{" "}
                          {Math.min(modelsPage * 15, filteredModels.length)} of {filteredModels.length} models
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setModelsPage((p) => Math.max(1, p - 1))}
                            disabled={modelsPage === 1}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-40 transition-colors"
                          >
                            <ChevronLeft size={13} />
                            <span>Previous</span>
                          </button>
                          <span className="px-2 text-zinc-300 font-medium">
                            {modelsPage} / {totalPages}
                          </span>
                          <button
                            onClick={() => setModelsPage((p) => Math.min(totalPages, p + 1))}
                            disabled={modelsPage === totalPages}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-40 transition-colors"
                          >
                            <span>Next</span>
                            <ChevronRight size={13} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/*  TAB 3: TELEMETRY ─ */}
          {activeTab === "telemetry" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-zinc-100">
                  Telemetry & Live Metrics
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Real-time request metrics, token counts, and latency analysis.
                </p>
              </div>

              {/* KPI Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Total Requests (24h)
                  </p>
                  <p className="text-2xl font-bold text-zinc-100 mt-2 font-mono">
                    {stats?.total_requests?.toLocaleString() || 0}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Total Tokens
                  </p>
                  <p className="text-2xl font-bold text-amber-400 mt-2 font-mono">
                    {formatTokens(stats?.total_tokens)}
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Avg Latency
                  </p>
                  <p className="text-2xl font-bold text-cyan-400 mt-2 font-mono">
                    {Math.round(stats?.avg_latency_ms || 0)} ms
                  </p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Active Concurrency
                  </p>
                  <p className="text-2xl font-bold text-emerald-400 mt-2 font-mono">
                    {activeRequests} calls
                  </p>
                </div>
              </div>

              {/* Telemetry Table */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden shadow-sm">
                <div className="border-b border-zinc-800 px-4 py-3 text-xs font-semibold text-zinc-300">
                  Recent Invocations
                </div>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/80 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                      <th className="py-2.5 px-4">Timestamp</th>
                      <th className="py-2.5 px-4">Model</th>
                      <th className="py-2.5 px-4">Tokens</th>
                      <th className="py-2.5 px-4">Latency</th>
                      <th className="py-2.5 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 font-mono">
                    {telemetryLogs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-zinc-500 font-sans">
                          No requests logged yet.
                        </td>
                      </tr>
                    ) : (
                      telemetryLogs.map((l) => (
                        <tr key={l.id} className="hover:bg-zinc-800/30">
                          <td className="py-2.5 px-4 text-zinc-400">{l.created_at}</td>
                          <td className="py-2.5 px-4 text-zinc-200">{l.model || "passthrough"}</td>
                          <td className="py-2.5 px-4 text-amber-400">{formatTokens(l.total_tokens)}</td>
                          <td className="py-2.5 px-4 text-zinc-300">{l.latency_ms} ms</td>
                          <td className="py-2.5 px-4">
                            <span
                              className={`font-semibold ${l.status === 200 ? "text-emerald-400" : "text-red-400"
                                }`}
                            >
                              {l.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/*  TAB 4: ENGINE SETTINGS  */}
          {activeTab === "admin" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-zinc-100">
                  Engine Optimizations & System
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Toggle gateway-level caching, compression, and inspect server hardware.
                </p>
              </div>

              {/* Optimizations */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-sm space-y-4">
                <h3 className="text-sm font-semibold text-zinc-200">Gateway Optimizations</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {[
                    { key: "cacheEnabled", label: "Semantic Response Cache" },
                    { key: "rtkCompression", label: "RTK Compression" },
                    { key: "cavemanMode", label: "Caveman Token Trimmer" },
                    { key: "minifyPrompt", label: "Prompt Whitespace Minification" },
                    { key: "httpsOnly", label: "Enforce HTTPS Only" },
                    { key: "modelPrefixEnabled", label: "Model Prefix Routing" },
                  ].map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 cursor-pointer hover:bg-zinc-900 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={!!optimizations[item.key]}
                        onChange={(e) => toggleOptimization(item.key, e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-zinc-100 accent-zinc-100"
                      />
                      <span className="text-xs font-medium text-zinc-200">{item.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Hardware */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-zinc-200 mb-3">Hardware & Environment</h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <p className="text-[10px] font-semibold text-zinc-500 uppercase">Platform / Arch</p>
                    <p className="text-sm font-semibold text-zinc-200 mt-1 font-mono">
                      {systemInfo?.platform} ({systemInfo?.arch})
                    </p>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <p className="text-[10px] font-semibold text-zinc-500 uppercase">CPUs</p>
                    <p className="text-sm font-semibold text-zinc-200 mt-1 font-mono">
                      {systemInfo?.cpus} Cores
                    </p>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <p className="text-[10px] font-semibold text-zinc-500 uppercase">Memory Free / Total</p>
                    <p className="text-sm font-semibold text-zinc-200 mt-1 font-mono">
                      {systemInfo?.freeMemoryMB} MB / {systemInfo?.totalMemoryMB} MB
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
