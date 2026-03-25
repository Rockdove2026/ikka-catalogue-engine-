import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase.js";

/* ── Design tokens — same Rock Dove DNA ─────────────────── */
const C = {
  ink:     "#1A1614",
  stone:   "#F5F0EA",
  warm:    "#EDE8E0",
  sidebar: "#0e0c0b",
  roseMid: "#C47080",
  rose:    "#D4909A",
  blue:    "#A8C8DC",
  cobalt:  "#2A5FAD",
  red:     "#C0302A",
  muted:   "#8A7A72",
  rule:    "#C8B8B0",
  green:   "#5a8a5a",
  amber:   "#c8a96e",
  gold:    "#b8912a",
};

const CATALOGUE_URL = import.meta.env.VITE_CATALOGUE_SERVICE_URL ||
  "https://ikka-catalogue-service-production.up.railway.app";

const OCCASIONS = [
  "All", "Diwali", "New Year", "Birthday", "Work Anniversary",
  "Deal Milestone", "Onboarding", "Thank You", "Corporate Event", "Custom",
];

const TIER_COLOR = {
  Platinum: C.cobalt,
  Gold:     C.gold,
  Silver:   C.muted,
};

/* ── Price at quantity using pricing_tiers ───────────────── */
function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  const match = tiers
    .filter(t => qty >= t.min_qty && (t.max_qty === null || qty <= t.max_qty))
    .sort((a, b) => b.min_qty - a.min_qty)[0];
  return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
}

/* ── AI scoring: returns 0-100 fit score ─────────────────── */
function scoreProduct(p, params) {
  let score = p.popularity || 0; // base from popularity
  const qty  = parseInt(params.qty) || 1;
  const budget = parseFloat(params.budget) || Infinity;
  const days = parseInt(params.days) || 999;
  const occ  = params.occasion;

  // Price fit
  const price = priceAtQty(p.pricing_tiers, qty);
  if (price <= budget) score += 30;
  else if (price <= budget * 1.1) score += 10; // within 10% tolerance

  // Occasion match
  if (occ && occ !== "All") {
    const occLower = occ.toLowerCase();
    const productOccs = (p.occasions || "").toLowerCase();
    if (productOccs.includes(occLower)) score += 25;
  } else {
    score += 15; // neutral
  }

  // Lead time fit
  const leadDays = { in_stock: 3, short: 30, medium: 45, long: 60 };
  const lt = leadDays[p.lead_time] || 3;
  if (lt <= days) score += 20;
  else if (lt <= days * 1.2) score += 5;
  else score -= 20;

  // Tier premium
  if (p.tier === "Platinum") score += 5;

  return Math.min(100, Math.max(0, score));
}

/* ══════════════════════════════════════════════════════════ */
export default function App() {
  const [tab, setTab]   = useState("query"); // query | admin

  /* query state */
  const [params, setParams]       = useState({ budget: "", qty: "", days: "", occasion: "All", excludeEdible: false, excludeFragile: false });
  const [products, setProducts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState(new Set());
  const [showPreview, setShowPreview] = useState(false);
  const [pdfLoading, setPdfLoading]  = useState(false);
  const [pdfUrl, setPdfUrl]          = useState(null);
  const [clientName, setClientName]  = useState("");
  const [showPdfMeta, setShowPdfMeta] = useState(false);
  const [sortBy, setSortBy]          = useState("score");

  /* admin state */
  const [adminView, setAdminView]    = useState("list"); // list | add | edit | csv
  const [editProduct, setEditProduct] = useState(null);
  const [saving, setSaving]          = useState(false);
  const [form, setForm]              = useState({ name: "", category: "", price: "", tier: "Silver", image_url: "", occasions: "", description: "", edible: false, fragile: false, customisable: true, popularity: 50 });
  const [csvRows, setCsvRows]        = useState([]);
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvStatus, setCsvStatus]    = useState(null);

  /* parse CSV */
  const parseCSV = (text) => {
    const lines = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    return lines.slice(1).filter(l => l.trim()).map(line => {
      const vals = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === "," && !inQ) { vals.push(cur); cur = ""; }
        else cur += ch;
      }
      vals.push(cur);
      const row = {};
      headers.forEach((h, i) => { row[h] = (vals[i] || "").trim().replace(/^"|"$/g, ""); });
      return row;
    });
  };

  const handleCSVFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvRows(parseCSV(ev.target.result)); setCsvStatus(null); };
    reader.readAsText(file);
  };

  const uploadCSV = async () => {
    if (!csvRows.length) return;
    setCsvUploading(true); setCsvStatus(null);
    const errors = []; let ok = 0;
    for (const row of csvRows) {
      if (!row.name || !row.price) { errors.push("Skipped row: missing name or price"); continue; }
      const bool = v => v === "true" || v === "1" || v === "yes";
      const tierVal = row.tier || "Silver";
      const p = parseFloat(row.price) || 0;
      const payload = {
        name: row.name, category: row.category || "", price: p, tier: tierVal,
        description: row.description || "", occasions: row.occasions || "",
        image_url: row.image_url || "", edible: bool(row.edible),
        fragile: bool(row.fragile), customisable: bool(row.customisable !== "" ? row.customisable : "true"),
        popularity: parseInt(row.popularity) || 50,
        lead_time: tierVal === "Platinum" ? "in_stock" : tierVal === "Gold" ? "short" : "medium",
        active: true,
      };
      const { data: ins, error } = await supabase.from("catalog").insert([payload]).select().single();
      if (error) { errors.push(row.name + ": " + error.message); continue; }
      if (ins) {
        await supabase.from("pricing_tiers").insert([
          { product_id: ins.id, min_qty: 1,    max_qty: 99,   price_per_unit: p },
          { product_id: ins.id, min_qty: 100,  max_qty: 199,  price_per_unit: p * 0.85 },
          { product_id: ins.id, min_qty: 200,  max_qty: 499,  price_per_unit: p * 0.80 },
          { product_id: ins.id, min_qty: 500,  max_qty: 999,  price_per_unit: p * 0.70 },
          { product_id: ins.id, min_qty: 1000, max_qty: null, price_per_unit: p * 0.60 },
        ]);
        ok++;
      }
    }
    setCsvStatus({ ok, errors }); setCsvUploading(false);
    if (ok > 0) { loadProducts(); setCsvRows([]); }
  };

  /* load products + pricing tiers */
  const loadProducts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("catalog")
      .select("*, pricing_tiers(*)")
      .eq("active", true)
      .order("popularity", { ascending: false });
    if (!error) setProducts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  /* filtered + scored products */
  const results = useMemo(() => {
    const qty    = parseInt(params.qty) || 1;
    const budget = parseFloat(params.budget) || Infinity;
    const days   = parseInt(params.days) || 999;

    return products
      .filter(p => {
        if (params.excludeEdible && p.edible) return false;
        if (params.excludeFragile && p.fragile) return false;
        const price = priceAtQty(p.pricing_tiers, qty);
        if (budget < Infinity && price > budget * 1.1) return false; // allow 10% flex
        const leadDays = { in_stock: 3, short: 30, medium: 45, long: 60 };
        if ((leadDays[p.lead_time] || 3) > days * 1.2) return false;
        if (qty < (p.moq || 1)) return false;
        return true;
      })
      .map(p => ({ ...p, _score: scoreProduct(p, params), _price: priceAtQty(p.pricing_tiers, parseInt(params.qty) || 1) }))
      .sort((a, b) => {
        if (sortBy === "score")      return b._score - a._score;
        if (sortBy === "price_asc")  return a._price - b._price;
        if (sortBy === "price_desc") return b._price - a._price;
        return 0;
      });
  }, [products, params, sortBy]);

  /* auto-select top results when params change */
  useEffect(() => {
    if (results.length > 0) {
      setSelected(new Set(results.filter(p => p._score >= 40).map(p => p.id)));
    }
  }, [results]);

  /* log request to client_requests */
  const logRequest = useCallback(async (pdfUrl) => {
    await supabase.from("client_requests").insert([{
      budget_per_unit:  parseFloat(params.budget) || null,
      quantity:         parseInt(params.qty) || null,
      timeline_days:    parseInt(params.days) || null,
      occasion:         params.occasion !== "All" ? params.occasion : null,
      exclude_edible:   params.excludeEdible,
      exclude_fragile:  params.excludeFragile,
      results_count:    results.length,
      pdf_url:          pdfUrl || null,
    }]);
  }, [params, results]);

  /* generate PDF */
  const generatePDF = async () => {
    const sel = results.filter(p => selected.has(p.id));
    if (!sel.length) return;
    setPdfLoading(true); setPdfUrl(null);
    try {
      const qty = parseInt(params.qty) || 1;
      const res = await fetch(`${CATALOGUE_URL}/generate-catalogue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: sel.map(p => ({
            name:          p.name,
            origin:        p.category || "India",
            category:      p.category || "General",
            price:         Math.round(p._price),
            description:   p.description || "",
            occasions:     Array.isArray(p.occasions) ? p.occasions : (p.occasions || "").split("|").map(s=>s.trim()).filter(Boolean),
            lead_time:     { in_stock:"In Stock", short:"15–30 days", medium:"45 days", long:"60 days" }[p.lead_time] || "In Stock",
            moq:           (p.moq || 1) + " unit" + ((p.moq || 1) > 1 ? "s" : ""),
            customisation: p.customisable ? "Available on request" : "Not available",
            images:        p.image_url ? [p.image_url] : [],
          })),
          meta: {
            client_name:  clientName || "Valued Client",
            occasion:     params.occasion !== "All" ? params.occasion : "Corporate Gifting",
            event_date:   "",
            valid_until:  "",
          },
        }),
      });
      if (!res.ok) throw new Error("Service returned " + res.status);
      const data = await res.json();
      if (data.storage_url) { setPdfUrl(data.storage_url); logRequest(data.storage_url); }
      if (data.pdf_base64) {
        const blob = new Blob([Uint8Array.from(atob(data.pdf_base64), c => c.charCodeAt(0))], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = data.filename || "catalogue.pdf"; a.click();
      }
    } catch (err) { alert("PDF generation failed: " + err.message); }
    finally { setPdfLoading(false); setShowPdfMeta(false); }
  };

  /* admin save */
  const saveProduct = async () => {
    if (!form.name || !form.price) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name, category: form.category,
        price: parseFloat(form.price), tier: form.tier,
        image_url: form.image_url, occasions: form.occasions,
        description: form.description, edible: form.edible,
        fragile: form.fragile, customisable: form.customisable,
        popularity: parseInt(form.popularity) || 50,
        lead_time: form.tier === "Platinum" ? "in_stock" : form.tier === "Gold" ? "short" : "medium",
        active: true,
      };
      if (editProduct) {
        await supabase.from("catalog").update(payload).eq("id", editProduct.id);
      } else {
        const { data: ins } = await supabase.from("catalog").insert([payload]).select().single();
        if (ins) {
          // seed pricing tiers
          const tiers = [
            { product_id: ins.id, min_qty: 1,    max_qty: 99,   price_per_unit: parseFloat(form.price) },
            { product_id: ins.id, min_qty: 100,  max_qty: 199,  price_per_unit: parseFloat(form.price) * 0.85 },
            { product_id: ins.id, min_qty: 200,  max_qty: 499,  price_per_unit: parseFloat(form.price) * 0.80 },
            { product_id: ins.id, min_qty: 500,  max_qty: 999,  price_per_unit: parseFloat(form.price) * 0.70 },
            { product_id: ins.id, min_qty: 1000, max_qty: null, price_per_unit: parseFloat(form.price) * 0.60 },
          ];
          await supabase.from("pricing_tiers").insert(tiers);
        }
      }
      setForm({ name:"", category:"", price:"", tier:"Silver", image_url:"", occasions:"", description:"", edible:false, fragile:false, customisable:true, popularity:50 });
      setEditProduct(null); setAdminView("list"); loadProducts();
    } catch (err) { alert("Save failed: " + err.message); }
    finally { setSaving(false); }
  };

  const selectedProducts = results.filter(p => selected.has(p.id));
  const totalBudget = selectedProducts.reduce((s, p) => s + p._price * (parseInt(params.qty) || 1), 0);
  const P = { fontFamily: "'EB Garamond', serif" };

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { min-height: 100vh; }
        body { background: ${C.stone}; font-family: 'EB Garamond', serif; font-size: 16px; color: ${C.ink}; }
        input, select, textarea, button { font-family: inherit; }

        /* ── Header ── */
        .hdr { background: ${C.sidebar}; padding: 0 40px; display: flex; align-items: center; justify-content: space-between; height: 56px; }
        .hdr-brand { display: flex; align-items: baseline; gap: 12px; }
        .hdr-name { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 300; color: #fff; letter-spacing: 1px; }
        .hdr-name em { font-style: italic; color: ${C.blue}; }
        .hdr-sub { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #888; }
        .hdr-tabs { display: flex; gap: 2px; }
        .hdr-tab { padding: 8px 20px; background: none; border: none; font-size: 13px; letter-spacing: 2.5px; text-transform: uppercase; color: #fff; cursor: pointer; opacity: 0.4; font-weight: 500; border-bottom: 2px solid transparent; }
        .hdr-tab.on { opacity: 1; border-bottom-color: ${C.roseMid}; }

        /* ── Layout ── */
        .layout { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 56px); }
        .sidebar { background: #fff; border-right: 0.5px solid ${C.rule}; padding: 28px 24px; position: sticky; top: 0; height: calc(100vh - 56px); overflow-y: auto; }
        .main { padding: 28px 32px 60px; }

        /* ── Sidebar form ── */
        .s-title { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 900; color: ${C.ink}; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 4px; }
        .s-sub { font-size: 12px; color: ${C.muted}; margin-bottom: 24px; }
        .s-section { font-size: 11px; letter-spacing: 2.5px; text-transform: uppercase; color: ${C.ink}; font-weight: 700; padding-bottom: 7px; border-bottom: 1.5px solid ${C.ink}; margin-bottom: 14px; margin-top: 26px; }
        .s-field { margin-bottom: 16px; }
        .s-label { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: ${C.ink}; display: block; margin-bottom: 6px; }
        .s-inp { display: block; width: 100%; padding: 7px 0 8px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-size: 16px; font-style: italic; font-family: 'Cormorant Garamond', serif; color: ${C.ink}; outline: none; }
        .s-inp:focus { border-bottom-color: ${C.cobalt}; }
        .s-sel { display: block; width: 100%; padding: 7px 0 8px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-size: 14px; color: ${C.ink}; outline: none; -webkit-appearance: none; cursor: pointer; }
        .s-toggle { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 0.5px solid ${C.rule}; }
        .s-toggle:last-child { border-bottom: none; }
        .s-toggle-lbl { font-size: 13px; color: ${C.ink}; }
        .s-toggle-sub { font-size: 11px; color: ${C.muted}; }
        .s-chk { width: 16px; height: 16px; accent-color: ${C.cobalt}; cursor: pointer; flex-shrink: 0; }
        .s-btn { display: block; width: 100%; padding: 12px; background: ${C.cobalt}; border: none; color: #fff; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; cursor: pointer; margin-top: 20px; }
        .s-btn:hover { opacity: 0.9; }
        .s-btn-out { display: block; width: 100%; padding: 10px; background: transparent; border: 0.5px solid ${C.rule}; color: ${C.muted}; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; margin-top: 8px; }

        /* ── Results ── */
        .eyebrow { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: ${C.muted}; padding-bottom: 8px; border-bottom: 1.5px solid ${C.ink}; margin-bottom: 18px; display: flex; justify-content: space-between; align-items: center; }
        .product-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1px; background: ${C.rule}; }
        .p-card { background: #fff; cursor: pointer; position: relative; transition: background 0.15s; }
        .p-card.sel { background: #F9F5F0; outline: 2px solid ${C.ink}; outline-offset: -2px; }
        .p-card:hover { background: #FDFAF7; }
        .p-img { width: 100%; padding-bottom: 68%; position: relative; overflow: hidden; background: ${C.warm}; }
        .p-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .p-img-emoji { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 52px; }
        .p-check { position: absolute; top: 12px; right: 12px; width: 22px; height: 22px; background: ${C.ink}; display: flex; align-items: center; justify-content: center; z-index: 2; }
        .p-body { padding: 16px 18px 18px; }
        .p-cat-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .p-cat { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: ${C.muted}; }
        .p-tier { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; padding: 2px 8px; border: 0.5px solid; }
        .p-name { font-family: 'Cormorant Garamond', serif; font-size: 18px; line-height: 1.3; color: ${C.ink}; margin-bottom: 8px; }
        .p-desc { font-size: 12px; color: ${C.muted}; line-height: 1.55; margin-bottom: 12px; }
        .p-price { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 900; color: ${C.ink}; margin-bottom: 4px; }
        .p-price-sub { font-size: 11px; color: ${C.muted}; }
        .p-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
        .p-badge { font-size: 9px; letter-spacing: 1px; text-transform: uppercase; padding: 2px 8px; border: 0.5px solid ${C.rule}; color: ${C.muted}; }
        .p-score { position: absolute; top: 12px; left: 12px; background: rgba(14,12,11,0.75); color: #fff; font-size: 10px; letter-spacing: 1px; padding: 3px 8px; }

        /* ── Sort bar ── */
        .sort-bar { display: flex; gap: 4px; }
        .sort-btn { padding: 4px 12px; border: 0.5px solid; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; background: transparent; }

        /* ── Selection bar ── */
        .sel-bar { background: ${C.sidebar}; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px; position: sticky; bottom: 0; z-index: 50; }
        .sel-count { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #888; margin-bottom: 3px; }
        .sel-total { font-family: 'Playfair Display', serif; font-size: 26px; color: #fff; }
        .sel-qty { font-size: 11px; color: #666; margin-top: 2px; }
        .sel-btns { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .sel-btn-primary { padding: 10px 24px; background: #fff; color: ${C.sidebar}; border: none; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; font-weight: 500; }
        .sel-btn-sec { padding: 10px 20px; background: transparent; color: #fff; border: 1px solid #444; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; cursor: pointer; }

        /* ── PDF meta overlay ── */
        .overlay { position: fixed; inset: 0; background: rgba(26,22,20,0.7); display: flex; align-items: center; justify-content: center; z-index: 200; }
        .overlay-box { background: ${C.stone}; border: 0.5px solid ${C.rule}; padding: 36px; max-width: 440px; width: 90%; }
        .overlay-title { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 900; color: ${C.ink}; margin-bottom: 4px; }
        .overlay-sub { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: ${C.muted}; margin-bottom: 24px; }
        .o-label { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: ${C.ink}; display: block; margin-bottom: 7px; }
        .o-inp { display: block; width: 100%; padding: 6px 0 8px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-family: 'Cormorant Garamond', serif; font-size: 18px; font-style: italic; color: ${C.ink}; outline: none; margin-bottom: 20px; }
        .o-inp:focus { border-bottom-color: ${C.cobalt}; }
        .o-btns { display: flex; gap: 10px; margin-top: 8px; }
        .o-btn-p { flex: 1; padding: 13px; background: ${C.cobalt}; border: none; color: #fff; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; cursor: pointer; }
        .o-btn-s { padding: 13px 18px; border: 0.5px solid ${C.rule}; background: transparent; color: ${C.muted}; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; }

        /* ── Admin ── */
        .admin-layout { display: grid; grid-template-columns: 220px 1fr; min-height: calc(100vh - 56px); }
        .admin-side { background: #fff; border-right: 0.5px solid ${C.rule}; padding: 24px 20px; }
        .admin-main { padding: 28px 36px 60px; }
        .admin-s-title { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: ${C.muted}; margin-bottom: 14px; }
        .admin-s-item { display: block; width: 100%; text-align: left; padding: 9px 12px; background: none; border: none; border-left: 2px solid transparent; font-size: 14px; color: ${C.ink}; cursor: pointer; letter-spacing: 0.5px; margin-bottom: 2px; }
        .admin-s-item.on { border-left-color: ${C.roseMid}; background: ${C.stone}; font-weight: 500; }
        .admin-s-item:hover { background: ${C.stone}; }
        .admin-eyebrow { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: ${C.muted}; padding-bottom: 8px; border-bottom: 1.5px solid ${C.ink}; margin-bottom: 20px; }
        .admin-tbl { width: 100%; border-collapse: collapse; }
        .admin-th { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: ${C.muted}; padding: 0 12px 10px; text-align: left; border-bottom: 1px solid ${C.ink}; font-weight: 400; }
        .admin-td { font-size: 14px; color: ${C.ink}; padding: 11px 12px; border-bottom: 0.5px solid ${C.rule}; vertical-align: middle; font-family: 'Cormorant Garamond', serif; }
        .admin-td-sm { font-family: 'EB Garamond', serif; font-size: 12px; }
        .admin-act { font-family: 'EB Garamond', serif; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 3px 10px; border: 0.5px solid; background: transparent; cursor: pointer; }

        /* ── Form ── */
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
        .f-field { margin-bottom: 10px; }
        .f-label { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: ${C.ink}; display: block; margin-bottom: 8px; }
        .f-inp { display: block; width: 100%; padding: 6px 0 9px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-family: 'Cormorant Garamond', serif; font-size: 17px; font-style: italic; color: ${C.ink}; outline: none; }
        .f-inp:focus { border-bottom-color: ${C.cobalt}; }
        .f-sel { display: block; width: 100%; padding: 6px 0 9px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-family: 'EB Garamond', serif; font-size: 14px; color: ${C.ink}; outline: none; -webkit-appearance: none; cursor: pointer; }
        .f-ta { display: block; width: 100%; padding: 6px 0 9px; background: transparent; border: none; border-bottom: 1px solid ${C.rule}; font-family: 'Cormorant Garamond', serif; font-size: 16px; color: ${C.ink}; outline: none; resize: none; }
        .f-chk-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 0.5px solid ${C.rule}; margin-bottom: 8px; }
        .f-chk-lbl { font-size: 13px; color: ${C.ink}; }
        .f-save { padding: 13px 32px; background: ${C.cobalt}; border: none; color: #fff; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; cursor: pointer; margin-top: 8px; }
        .f-cancel { padding: 13px 20px; border: 0.5px solid ${C.rule}; background: transparent; color: ${C.muted}; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; cursor: pointer; margin-top: 8px; margin-right: 10px; }
        .loading { display: flex; align-items: center; justify-content: center; min-height: 300px; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: ${C.muted}; }
      `}</style>

      {/* ── HEADER ── */}
      <div className="hdr">
        <div className="hdr-brand">
          <div className="hdr-name">Ikka &thinsp;<em>Dukka</em></div>
          <div className="hdr-sub">Catalogue Engine</div>
        </div>
        <div className="hdr-tabs">
          {[["query","Query"],["admin","Admin"]].map(([k,l]) => (
            <button key={k} className={`hdr-tab${tab===k?" on":""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* ══ QUERY TAB ══ */}
      {tab === "query" && (
        <div className="layout">

          {/* Sidebar — query form */}
          <div className="sidebar">
            <div className="s-title">Find gifts</div>
            <div className="s-sub">Set your parameters. We'll rank the best matches.</div>

            <div className="s-section">Budget & Quantity</div>
            <div className="s-field">
              <label className="s-label">Budget per unit (₹)</label>
              <input className="s-inp" type="number" placeholder="e.g. 3000" value={params.budget} onChange={e => setParams(p => ({ ...p, budget: e.target.value }))}/>
            </div>
            <div className="s-field">
              <label className="s-label">Quantity (units)</label>
              <input className="s-inp" type="number" placeholder="e.g. 100" value={params.qty} onChange={e => setParams(p => ({ ...p, qty: e.target.value }))}/>
              {params.qty && parseInt(params.qty) >= 100 && (
                <div style={{ fontSize: 11, color: C.green, marginTop: 4 }}>
                  Volume pricing applies from 100+ units
                </div>
              )}
            </div>

            <div className="s-section">Timeline & Occasion</div>
            <div className="s-field">
              <label className="s-label">Days until event</label>
              <input className="s-inp" type="number" placeholder="e.g. 21" value={params.days} onChange={e => setParams(p => ({ ...p, days: e.target.value }))}/>
            </div>
            <div className="s-field">
              <label className="s-label">Occasion</label>
              <select className="s-sel" value={params.occasion} onChange={e => setParams(p => ({ ...p, occasion: e.target.value }))}>
                {OCCASIONS.map(o => <option key={o}>{o}</option>)}
              </select>
            </div>

            <div className="s-section">Restrictions</div>
            {[
              { key: "excludeEdible",  label: "Exclude edible items",  sub: "No food or beverage products" },
              { key: "excludeFragile", label: "Exclude fragile items",  sub: "Safe for courier / bulk shipping" },
            ].map(r => (
              <div className="s-toggle" key={r.key}>
                <div>
                  <div className="s-toggle-lbl">{r.label}</div>
                  <div className="s-toggle-sub">{r.sub}</div>
                </div>
                <input type="checkbox" className="s-chk" checked={params[r.key]} onChange={e => setParams(p => ({ ...p, [r.key]: e.target.checked }))}/>
              </div>
            ))}

            <div className="s-section">Sort results by</div>
            <select className="s-sel" value={sortBy} onChange={e => setSortBy(e.target.value)}>
              <option value="score">Best match (AI scored)</option>
              <option value="price_asc">Price low → high</option>
              <option value="price_desc">Price high → low</option>
            </select>

            {/* Stats */}
            <div style={{ marginTop: 24, padding: "14px 0", borderTop: `0.5px solid ${C.rule}` }}>
              <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: C.muted, marginBottom: 6 }}>Results</div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 900, color: C.ink }}>{results.length}</div>
              <div style={{ fontSize: 12, color: C.muted }}>products matched · {selected.size} selected</div>
            </div>
          </div>

          {/* Main — results grid */}
          <div className="main">
            {loading ? (
              <div className="loading">Loading catalogue…</div>
            ) : (
              <>
                <div className="eyebrow">
                  <span>{results.length} products</span>
                  <div className="sort-bar">
                    {[["score","Best Match"],["price_asc","Price ↑"],["price_desc","Price ↓"]].map(([v,l]) => (
                      <button key={v} onClick={() => setSortBy(v)}
                        className="sort-btn"
                        style={{ borderColor: sortBy===v ? C.ink : C.rule, color: sortBy===v ? C.ink : C.muted }}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>

                {results.length === 0 ? (
                  <div className="loading">No products match — try adjusting your filters</div>
                ) : (
                  <div className="product-grid">
                    {results.map(p => {
                      const isSel = selected.has(p.id);
                      const tierC = TIER_COLOR[p.tier] || C.muted;
                      const isUrl = p.image_url?.startsWith("http");
                      return (
                        <div key={p.id} className={`p-card${isSel ? " sel" : ""}`}
                          onClick={() => setSelected(prev => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
                          {/* Score badge */}
                          <div className="p-score">{p._score}% match</div>
                          {/* Check mark */}
                          {isSel && (
                            <div className="p-check">
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,6 5,9 10,3"/></svg>
                            </div>
                          )}
                          {/* Image */}
                          <div className="p-img">
                            {isUrl
                              ? <img src={p.image_url} alt={p.name}/>
                              : <div className="p-img-emoji">{p.fb_icon || "🎁"}</div>
                            }
                          </div>
                          {/* Card body */}
                          <div className="p-body">
                            <div className="p-cat-row">
                              <div className="p-cat">{p.category}</div>
                              <span className="p-tier" style={{ color: tierC, borderColor: tierC }}>{p.tier}</span>
                            </div>
                            <div className="p-name">{p.name}</div>
                            {p.description && <div className="p-desc">{p.description}</div>}
                            <div className="p-price">₹{p._price.toLocaleString("en-IN")}</div>
                            <div className="p-price-sub">per unit{params.qty && parseInt(params.qty) >= 100 ? " · volume price" : " · retail"}</div>
                            {params.qty && (
                              <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                                {params.qty} units = ₹{(p._price * parseInt(params.qty)).toLocaleString("en-IN")}
                              </div>
                            )}
                            <div className="p-meta">
                              {p.lead_time && (
                                <span className="p-badge" style={{ color: p.lead_time==="in_stock"?C.green:p.lead_time==="short"?C.amber:C.roseMid, borderColor: p.lead_time==="in_stock"?C.green:p.lead_time==="short"?C.amber:C.roseMid }}>
                                  {{ in_stock:"In Stock", short:"15–30 days", medium:"45 days", long:"60 days" }[p.lead_time]}
                                </span>
                              )}
                              {p.customisable && <span className="p-badge">Customisable</span>}
                              {p.edible && <span className="p-badge">Edible</span>}
                              {p.fragile && <span className="p-badge">Fragile</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Selection bar */}
                {selected.size > 0 && (
                  <div className="sel-bar">
                    <div>
                      <div className="sel-count">{selected.size} product{selected.size > 1 ? "s" : ""} selected</div>
                      <div className="sel-total">₹{totalBudget.toLocaleString("en-IN")}</div>
                      <div className="sel-qty">{params.qty || 1} units × {selected.size} products</div>
                    </div>
                    <div className="sel-btns">
                      <button className="sel-btn-sec" onClick={() => setShowPreview(v => !v)}>
                        {showPreview ? "Hide preview" : "Preview catalogue"}
                      </button>
                      <button className="sel-btn-primary" onClick={() => setShowPdfMeta(true)}>
                        Generate PDF →
                      </button>
                      {pdfUrl && (
                        <a href={pdfUrl} target="_blank" rel="noreferrer"
                          style={{ color: C.blue, fontSize: 12, fontFamily: "'EB Garamond', serif" }}>
                          View PDF ↗
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline preview */}
                {showPreview && selectedProducts.length > 0 && (
                  <div style={{ marginTop: 2, border: `1px solid ${C.rule}`, background: "#fff" }}>
                    <div style={{ background: C.sidebar, padding: "24px 32px" }}>
                      <div style={{ fontSize: 9, letterSpacing: ".2em", color: "#555", textTransform: "uppercase", marginBottom: 8 }}>Ikka Dukka · Curated Gift Catalogue</div>
                      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 24, color: "#fff", fontWeight: 300 }}>
                        {params.occasion !== "All" ? params.occasion : "Corporate Gifting"} Collection
                      </div>
                    </div>
                    <div style={{ padding: "24px 32px" }}>
                      {selectedProducts.map((p, i) => (
                        <div key={p.id} style={{ display: "flex", gap: 18, padding: "16px 0", borderBottom: i < selectedProducts.length-1 ? `1px solid #f0ece6` : "none" }}>
                          <div style={{ width: 56, height: 56, flexShrink: 0, background: C.warm, overflow: "hidden" }}>
                            {p.image_url?.startsWith("http")
                              ? <img src={p.image_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
                              : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>{p.fb_icon || "🎁"}</div>
                            }
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 16, color: C.ink, marginBottom: 4 }}>{p.name}</div>
                            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1 }}>{p.category}</div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: C.ink }}>₹{p._price.toLocaleString("en-IN")}</div>
                            <div style={{ fontSize: 11, color: C.muted }}>/unit</div>
                          </div>
                        </div>
                      ))}
                      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `2px solid ${C.ink}`, display: "flex", justifyContent: "flex-end" }}>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: C.muted, marginBottom: 4 }}>Total Estimate</div>
                          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, color: C.ink }}>₹{totalBudget.toLocaleString("en-IN")}</div>
                          <div style={{ fontSize: 11, color: C.muted }}>{params.qty || 1} units · {selectedProducts.length} products · excl. GST</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ══ ADMIN TAB ══ */}
      {tab === "admin" && (
        <div className="admin-layout">
          <div className="admin-side">
            <div className="admin-s-title">Admin Panel</div>
            {[["list","All Products"],["add","Add Product"],["csv","Bulk Upload CSV"]].map(([k,l]) => (
              <button key={k} className={`admin-s-item${adminView===k?" on":""}`}
                onClick={() => { setAdminView(k); setEditProduct(null); setForm({ name:"",category:"",price:"",tier:"Silver",image_url:"",occasions:"",description:"",edible:false,fragile:false,customisable:true,popularity:50 }); }}>
                {l}
              </button>
            ))}
          </div>

          <div className="admin-main">

            {/* Product list */}
            {adminView === "list" && (
              <>
                <div className="admin-eyebrow">All Products — {products.length} items</div>
                <div style={{ overflowX: "auto" }}>
                  <table className="admin-tbl">
                    <thead>
                      <tr>{["Name","Category","Price","Tier","Lead Time","Active",""].map((h,i) => <th className="admin-th" key={i}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {products.map(p => (
                        <tr key={p.id}>
                          <td className="admin-td">{p.name}</td>
                          <td className="admin-td admin-td-sm">{p.category}</td>
                          <td className="admin-td admin-td-sm">₹{parseFloat(p.price).toLocaleString("en-IN")}</td>
                          <td className="admin-td">
                            <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", padding: "2px 8px", border: `0.5px solid ${TIER_COLOR[p.tier]||C.muted}`, color: TIER_COLOR[p.tier]||C.muted }}>{p.tier}</span>
                          </td>
                          <td className="admin-td admin-td-sm">{{ in_stock:"In Stock", short:"15–30d", medium:"45d", long:"60d" }[p.lead_time]||"—"}</td>
                          <td className="admin-td admin-td-sm" style={{ color: p.active ? C.green : C.red }}>{p.active ? "Yes" : "No"}</td>
                          <td className="admin-td">
                            <button className="admin-act" style={{ borderColor: C.cobalt, color: C.cobalt }}
                              onClick={() => {
                                setEditProduct(p);
                                setForm({ name:p.name, category:p.category||"", price:String(p.price), tier:p.tier||"Silver", image_url:p.image_url||"", occasions:p.occasions||"", description:p.description||"", edible:p.edible||false, fragile:p.fragile||false, customisable:p.customisable!==false, popularity:p.popularity||50 });
                                setAdminView("edit");
                              }}>
                              Edit →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* CSV Upload */}
            {adminView === "csv" && (
              <>
                <div className="admin-eyebrow">Bulk Upload — CSV</div>
                <div style={{marginBottom:20,padding:16,background:"#fff",border:`0.5px solid ${C.rule}`}}>
                  <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:C.ink,marginBottom:6}}>CSV Format</div>
                  <div style={{fontFamily:"'EB Garamond',serif",fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:12}}>
                    Required columns: <strong>name, price</strong><br/>
                    Optional: category, tier (Silver/Gold/Platinum), description, occasions (pipe-separated e.g. Diwali|Birthday), image_url, edible, fragile, customisable, popularity (0–100)
                  </div>
                  <a href="/product_upload_template.csv" download style={{fontFamily:"'EB Garamond',serif",fontSize:12,letterSpacing:1.5,textTransform:"uppercase",color:C.cobalt}}>
                    Download template →
                  </a>
                </div>
                <div style={{marginBottom:20}}>
                  <label className="f-label">Select CSV file</label>
                  <input type="file" accept=".csv" onChange={handleCSVFile}
                    style={{display:"block",width:"100%",padding:"8px 0",fontFamily:"'EB Garamond',serif",fontSize:14,color:C.ink,borderBottom:`1px solid ${C.rule}`,background:"transparent",outline:"none",cursor:"pointer"}}/>
                </div>
                {csvRows.length > 0 && (
                  <div style={{marginBottom:20}}>
                    <div style={{fontFamily:"'EB Garamond',serif",fontSize:13,color:C.muted,marginBottom:10}}>{csvRows.length} rows ready to upload</div>
                    <div style={{overflowX:"auto",maxHeight:280,border:`0.5px solid ${C.rule}`}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontFamily:"'EB Garamond',serif",fontSize:13}}>
                        <thead>
                          <tr>{Object.keys(csvRows[0]).map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",borderBottom:`1px solid ${C.ink}`,fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:C.muted,fontWeight:400,whiteSpace:"nowrap"}}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {csvRows.slice(0,5).map((r,i)=>(
                            <tr key={i} style={{borderBottom:`0.5px solid ${C.rule}`}}>
                              {Object.values(r).map((v,j)=><td key={j} style={{padding:"6px 10px",color:C.ink,whiteSpace:"nowrap",maxWidth:160,overflow:"hidden",textOverflow:"ellipsis"}}>{v}</td>)}
                            </tr>
                          ))}
                          {csvRows.length > 5 && <tr><td colSpan={Object.keys(csvRows[0]).length} style={{padding:"6px 10px",color:C.muted,fontSize:12}}>…and {csvRows.length-5} more rows</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <button onClick={uploadCSV} disabled={csvUploading} className="f-save" style={{marginTop:16}}>
                      {csvUploading ? `Uploading…` : `Upload ${csvRows.length} Products →`}
                    </button>
                  </div>
                )}
                {csvStatus && (
                  <div style={{padding:16,background:csvStatus.errors.length===0?"#f0f8f0":"#fff8f0",border:`0.5px solid ${csvStatus.errors.length===0?C.green:C.amber}`}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:csvStatus.errors.length===0?C.green:C.amber,marginBottom:6}}>
                      {csvStatus.ok} product{csvStatus.ok!==1?"s":""} uploaded successfully
                    </div>
                    {csvStatus.errors.map((e,i)=><div key={i} style={{fontSize:12,color:C.red,fontFamily:"'EB Garamond',serif"}}>{e}</div>)}
                  </div>
                )}
              </>
            )}

            {/* Add / Edit form */}
            {(adminView === "add" || adminView === "edit") && (
              <>
                <div className="admin-eyebrow">{editProduct ? `Editing — ${editProduct.name}` : "Add New Product"}</div>
                <div className="form-grid">
                  {[
                    { key:"name",      label:"Product Name",    type:"text",   full:true },
                    { key:"category",  label:"Category",        type:"text"   },
                    { key:"price",     label:"Base Price (₹)",  type:"number" },
                    { key:"image_url", label:"Image URL",        type:"text",   full:true },
                    { key:"occasions", label:"Occasions (comma-separated)", type:"text", full:true },
                    { key:"popularity",label:"Popularity (0–100)", type:"number" },
                  ].map(f => (
                    <div key={f.key} className="f-field" style={f.full ? { gridColumn:"1 / -1" } : {}}>
                      <label className="f-label">{f.label}</label>
                      <input type={f.type} className="f-inp" value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}/>
                    </div>
                  ))}
                  <div className="f-field" style={{ gridColumn:"1 / -1" }}>
                    <label className="f-label">Description</label>
                    <textarea rows={3} className="f-ta" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}/>
                  </div>
                  <div className="f-field">
                    <label className="f-label">Tier</label>
                    <select className="f-sel" value={form.tier} onChange={e => setForm(p => ({ ...p, tier: e.target.value }))}>
                      {["Silver","Gold","Platinum"].map(t => <option key={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ margin: "8px 0 20px" }}>
                  <div style={{ fontSize: 10, letterSpacing: 3, textTransform: "uppercase", color: C.ink, marginBottom: 10 }}>Attributes</div>
                  {[
                    { key:"edible",      label:"Edible / food product" },
                    { key:"fragile",     label:"Fragile item" },
                    { key:"customisable",label:"Available for customisation" },
                  ].map(a => (
                    <div className="f-chk-row" key={a.key}>
                      <div className="f-chk-lbl">{a.label}</div>
                      <input type="checkbox" className="s-chk" checked={form[a.key]} onChange={e => setForm(p => ({ ...p, [a.key]: e.target.checked }))}/>
                    </div>
                  ))}
                </div>

                <div>
                  <button className="f-cancel" onClick={() => { setAdminView("list"); setEditProduct(null); }}>Cancel</button>
                  <button className="f-save" onClick={saveProduct} disabled={saving}>
                    {saving ? "Saving…" : editProduct ? "Save Changes →" : "Add Product →"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── PDF Meta Overlay ── */}
      {showPdfMeta && (
        <div className="overlay" onClick={() => setShowPdfMeta(false)}>
          <div className="overlay-box" onClick={e => e.stopPropagation()}>
            <div className="overlay-title">Generate Catalogue</div>
            <div className="overlay-sub">{selectedProducts.length} products selected</div>
            <label className="o-label">Client / Company Name</label>
            <input className="o-inp" type="text" placeholder="e.g. Axis Bank" value={clientName} onChange={e => setClientName(e.target.value)}/>
            <div className="o-btns">
              <button className="o-btn-s" onClick={() => setShowPdfMeta(false)}>Cancel</button>
              <button className="o-btn-p" onClick={generatePDF} disabled={pdfLoading}>
                {pdfLoading ? "Generating…" : "Generate & Download →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
