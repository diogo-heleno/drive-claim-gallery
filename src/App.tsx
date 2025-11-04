import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

type Item = {
  id: string;
  image_url: string;
  title: string | null;
  owner: string | null;
  created_at: string;
  updated_at: string;
};

const OWNERS = ["Mãe","Pai","Sandra","Sofia","Diogo & Susana","Daniel","Eduardo"];

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN as string;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

function normalizeImageUrl(raw: string) {
  const url = raw.trim();
  if (!url) return url;
  const m = url.match(/https?:\/\/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m && m[1]) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  return url;
}

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [ownerFilter, setOwnerFilter] = useState<string>("todos");
  const [onlyUntitled, setOnlyUntitled] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const [showImport, setShowImport] = useState(false);
  const [pin, setPin] = useState("");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  // Lightbox + zoom/pan
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);

  // Gestos/pointers
  const draggingRef = useRef(false);
  const lastPosRef = useRef<{x:number;y:number}>({x:0,y:0});

  // Pointer Events para pinch
  const pointersRef = useRef<Map<number, {x:number, y:number}>>(new Map());
  const pinchStartScaleRef = useRef(1);
  const pinchStartTxRef = useRef(0);
  const pinchStartTyRef = useRef(0);
  const pinchStartCenterRef = useRef<{x:number;y:number}>({x:0,y:0});
  const pinchStartDistRef = useRef<number | null>(null);

  // Bloquear scroll do fundo quando o lightbox está aberto
  useEffect(() => {
    if (lightboxIndex !== null) {
      const prevOverflow = document.body.style.overflow;
      const prevPos = document.body.style.position;
      document.body.style.overflow = "hidden";
      document.body.style.position = "fixed";
      return () => {
        document.body.style.overflow = prevOverflow;
        document.body.style.position = prevPos;
      };
    }
  }, [lightboxIndex]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase.from("items").select("*").order("created_at", { ascending: false });
      setItems(data || []);
      setLoading(false);
    })();

    const channel = supabase
      .channel("realtime:items")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "items" }, (p: any) => {
        setItems(prev => [p.new as Item, ...prev.filter(i => i.id !== p.new.id)]);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "items" }, (p: any) => {
        setItems(prev => prev.map(i => (i.id === p.new.id ? (p.new as Item) : i)));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const filtered = useMemo(() => {
    let list = items;
    if (q.trim()) list = list.filter(i => (i.title || "").toLowerCase().includes(q.trim().toLowerCase()));
    if (ownerFilter === "__none__") list = list.filter(i => !i.owner);
    else if (ownerFilter !== "todos") list = list.filter(i => i.owner === ownerFilter);
    if (onlyUntitled) list = list.filter(i => !i.title || i.title.trim() === "");
    return list;
  }, [items, q, ownerFilter, onlyUntitled]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  async function updateItem(id: string, patch: Partial<Item>) {
    const { error } = await supabase.from("items").update(patch).eq("id", id);
    if (error) alert("Erro ao guardar: " + error.message);
  }

  async function handleImport() {
    if (pin !== String(ADMIN_PIN)) return alert("PIN inválido");
    const urls = importText.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(normalizeImageUrl);
    const unique = urls.filter(u => u.startsWith("http") && !items.some(it => it.image_url === u));
    if (!unique.length) return alert("Nenhum link novo para importar.");
    setImporting(true);
    const { error } = await supabase.from("items").insert(unique.map(u => ({ image_url: u })));
    setImporting(false);
    if (error) return alert("Erro ao importar: " + error.message);
    setImportText("");
    setShowImport(false);
  }

  // ------- Lightbox helpers -------
  function openLightbox(idx: number) {
    setLightboxIndex(idx);
    setScale(1); setTx(0); setTy(0);
  }
  function closeLightbox() {
    setLightboxIndex(null);
    setScale(1); setTx(0); setTy(0);
    draggingRef.current = false;
    pointersRef.current.clear();
    pinchStartDistRef.current = null;
  }
  function resetView() { setScale(1); setTx(0); setTy(0); }

  // Clamping do pan para não “perder” a imagem
  function clampPan(nx: number, ny: number, s: number) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = imgW * s;
    const h = imgH * s;
    const overX = Math.max(0, (w - vw) / 2);
    const overY = Math.max(0, (h - vh) / 2);
    return {
      x: Math.max(-overX, Math.min(overX, nx)),
      y: Math.max(-overY, Math.min(overY, ny)),
    };
  }

  // Re-clamp quando muda o scale ou no resize
  useEffect(() => {
    const { x, y } = clampPan(tx, ty, scale);
    if (x !== tx) setTx(x);
    if (y !== ty) setTy(y);
    function onResize() {
      const r = clampPan(tx, ty, scale);
      setTx(r.x); setTy(r.y);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [scale]); // eslint-disable-line

  // Desktop: roda para zoom
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setScale(s => Math.min(6, Math.max(1, s * factor)));
  }

  // ---------- Pointer Events (rato + toque) ----------
  function getCenterAndDist() {
    const pts = Array.from(pointersRef.current.values());
    if (pts.length < 2) return { center: null as null | {x:number;y:number}, dist: 0 };
    const [a, b] = pts;
    const center = { x: (a.x + b.x)/2, y: (a.y + b.y)/2 };
    const dx = a.x - b.x, dy = a.y - b.y;
    return { center, dist: Math.hypot(dx, dy) };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const { center } = getCenterAndDist();
      pinchStartScaleRef.current = scale;
      pinchStartTxRef.current = tx;
      pinchStartTyRef.current = ty;
      pinchStartCenterRef.current = center || { x: e.clientX, y: e.clientY };
      pinchStartDistRef.current = null; // define na primeira move
    } else if (pointersRef.current.size === 1) {
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      draggingRef.current = true;
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const pts = Array.from(pointersRef.current.values());
    if (pts.length >= 2) {
      e.preventDefault();
      const { center, dist } = getCenterAndDist();
      if (!center || dist === 0) return;

      // inicializar distância “0” na primeira move
      if (pinchStartDistRef.current == null) {
        pinchStartDistRef.current = dist;
        return;
      }

      let nextScale = pinchStartScaleRef.current * (dist / (pinchStartDistRef.current || dist));
      nextScale = Math.min(6, Math.max(1, nextScale));

      // manter o centro do gesto estável
      const dx = center.x - pinchStartCenterRef.current.x;
      const dy = center.y - pinchStartCenterRef.current.y;
      const k = nextScale / pinchStartScaleRef.current;

      const nextTx = pinchStartTxRef.current * k + dx;
      const nextTy = pinchStartTyRef.current * k + dy;
      const clamped = clampPan(nextTx, nextTy, nextScale);

      setScale(nextScale);
      setTx(clamped.x);
      setTy(clamped.y);
    } else if (draggingRef.current && scale > 1) {
      e.preventDefault();
      const dx = e.clientX - lastPosRef.current.x;
      const dy = e.clientY - lastPosRef.current.y;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      const r = clampPan(tx + dx, ty + dy, scale);
      setTx(r.x); setTy(r.y);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) {
      pinchStartDistRef.current = null;
    }
    if (pointersRef.current.size === 0) {
      draggingRef.current = false;
    }
  }
  // ---------- fim Pointer Events ----------

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") closeLightbox();
    if (e.key === "+" || e.key === "=") setScale(s => Math.min(6, s * 1.1));
    if (e.key === "-" || e.key === "_") setScale(s => Math.max(1, s * 0.9));
    if (e.key === "0") { setScale(1); setTx(0); setTy(0); }
    if (e.key === "ArrowRight" && lightboxIndex !== null) setLightboxIndex(i => (i! + 1) % filtered.length);
    if (e.key === "ArrowLeft" && lightboxIndex !== null) setLightboxIndex(i => (i! - 1 + filtered.length) % filtered.length);
  }

  const currentItem = lightboxIndex !== null ? filtered[lightboxIndex] : null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto p-4 flex gap-3 items-center">
          <h1 className="text-xl font-semibold">Arrecadação • Galeria</h1>
          <div className="ml-auto flex gap-2">
            <input
              className="px-3 py-2 border rounded-xl text-sm w-64"
              placeholder="Pesquisar título…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <select
              className="px-3 py-2 border rounded-xl text-sm"
              value={ownerFilter}
              onChange={e => { setOwnerFilter(e.target.value); setPage(1); }}
            >
              <option value="todos">Todos</option>
              <option value="__none__">Sem dono</option>
              {OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyUntitled} onChange={e => setOnlyUntitled(e.target.checked)} />
              Só sem título
            </label>
            <button
              onClick={() => setShowImport(true)}
              className="px-3 py-2 border rounded-xl text-sm hover:bg-neutral-50"
            >
              Importar links
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4">
        {loading ? (
          <div className="py-24 text-center text-neutral-500">A carregar…</div>
        ) : (
          <>
            {pageItems.length === 0 ? (
              <div className="py-24 text-center text-neutral-500">Sem resultados.</div>
            ) : (
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                {pageItems.map((item, idx) => (
                  <div key={item.id} className="bg-white rounded-2xl shadow-card overflow-hidden border">
                    <div className="aspect-[4/3] bg-neutral-100 overflow-hidden">
                      <img
                        src={item.image_url}
                        alt={item.title || "Imagem"}
                        className="w-full h-full object-cover cursor-zoom-in select-none"
                        draggable={false}
                        referrerPolicy="no-referrer"
                        onClick={() => setLightboxIndex((page - 1) * PAGE_SIZE + idx)}
                        onError={e => {
                          const el = e.currentTarget as HTMLImageElement;
                          const m = item.image_url.match(/id=([^&]+)/);
                          if (m && m[1]) el.src = `https://lh3.googleusercontent.com/d/${m[1]}=w1200`;
                        }}
                      />
                    </div>
                    <div className="p-3 space-y-2">
                      <input
                        defaultValue={item.title || ""}
                        placeholder="Título (ex.: cadeirão da sala)"
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                        onBlur={e => {
                          const val = e.target.value.trim();
                          if (val !== (item.title || "")) updateItem(item.id, { title: val || null });
                        }}
                      />
                      <select
                        className="w-full px-3 py-2 border rounded-xl text-sm"
                        value={item.owner || "__none__"}
                        onChange={e => updateItem(item.id, { owner: e.target.value === "__none__" ? null : e.target.value })}
                      >
                        <option value="__none__">Sem dono</option>
                        {OWNERS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                      <div className="text-xs text-neutral-500 flex justify-between">
                        <span>{item.owner || "Sem dono"}</span>
                        <span>{new Date(item.updated_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-center items-center gap-3 mt-6">
              <button
                className="px-3 py-2 border rounded-xl text-sm disabled:opacity-50"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >Anterior</button>
              <span className="text-sm text-neutral-600">Página {page} de {totalPages}</span>
              <button
                className="px-3 py-2 border rounded-xl text-sm disabled:opacity-50"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >Seguinte</button>
            </div>
          </>
        )}
      </main>

      {/* LIGHTBOX */}
      {currentItem && (
        <div
          className="fixed inset-0 z-50 bg-black/90 text-white overscroll-contain"
          onKeyDown={onKeyDown}
          tabIndex={0}
        >
          <div className="absolute inset-0">
            <div
              className="w-full h-full cursor-grab active:cursor-grabbing overflow-hidden"
              style={{ touchAction: "none" }}  // essencial para pinch funcionar
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={resetView}
            >
              <img
                ref={imgRef}
                src={currentItem.image_url}
                alt={currentItem.title || "Imagem"}
                draggable={false}
                className="pointer-events-none select-none absolute top-1/2 left-1/2 max-w-none"
                style={{
                  transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`,
                  transition: (draggingRef.current || pointersRef.current.size > 0) ? "none" : "transform 80ms ease-out"
                }}
                onLoad={(e) => {
                  const el = e.currentTarget as HTMLImageElement;
                  setImgW(el.naturalWidth || el.width);
                  setImgH(el.naturalHeight || el.height);
                  const r = clampPan(0, 0, 1);
                  setTx(r.x); setTy(r.y);
                }}
                onError={e => {
                  const el = e.currentTarget as HTMLImageElement;
                  const m = currentItem.image_url.match(/id=([^&]+)/);
                  if (m && m[1]) el.src = `https://lh3.googleusercontent.com/d/${m[1]}=w2400`;
                }}
              />
            </div>
          </div>

          <div className="absolute top-3 left-3 right-3 flex items-center gap-2">
            <div className="px-3 py-1 rounded bg-white/10 text-xs">
              {currentItem.title || "Sem título"} {currentItem.owner ? `• ${currentItem.owner}` : ""}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={resetView} className="px-3 py-2 rounded bg-white/15 hover:bg-white/25 text-sm">Reset</button>
              <button onClick={closeLightbox} className="px-3 py-2 rounded bg-white hover:bg-white/90 text-black text-sm">Fechar (Esc)</button>
            </div>
          </div>

          <button
            onClick={() => setLightboxIndex(i => (i! - 1 + filtered.length) % filtered.length)}
            className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-2 bg-white/15 hover:bg-white/25 rounded"
            aria-label="Anterior"
          >&larr;</button>
          <button
            onClick={() => setLightboxIndex(i => (i! + 1) % filtered.length)}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-2 bg-white/15 hover:bg-white/25 rounded"
            aria-label="Seguinte"
          >&rarr;</button>
        </div>
      )}

      {showImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-40">
          <div className="bg-white w-full max-w-2xl rounded-2xl p-4 space-y-3">
            <h2 className="text-lg font-semibold">Importar links de imagens</h2>
            <p className="text-sm text-neutral-600">
              Cole um link por linha. Links do Google Drive no formato <code>file/d/ID/view</code> são convertidos automaticamente.
            </p>
            <div className="flex gap-2 items-center">
              <input
                type="password"
                placeholder="PIN de admin"
                className="px-3 py-2 border rounded-xl text-sm w-40"
                value={pin}
                onChange={e => setPin(e.target.value)}
              />
              <span className="text-xs text-neutral-500">Definido via VITE_ADMIN_PIN</span>
            </div>
            <textarea
              rows={10}
              className="w-full px-3 py-2 border rounded-xl text-sm"
              placeholder="https://drive.google.com/file/d/FILE_ID/view?usp=sharing"
              value={importText}
              onChange={e => setImportText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className="px-3 py-2 border rounded-xl text-sm" onClick={() => setShowImport(false)}>Cancelar</button>
              <button
                className="px-3 py-2 border rounded-xl text-sm bg-neutral-900 text-white disabled:opacity-50"
                onClick={handleImport}
                disabled={importing}
              >
                {importing ? "A importar…" : "Importar"}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center text-xs text-neutral-500 py-8">
        Clica numa imagem para ampliar. Pinça para zoom, arrasta para mover, duplo-clique para reset.
      </footer>
    </div>
  );
}
