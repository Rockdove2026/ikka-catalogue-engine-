import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const C = {
  ink:     "#1A1614",
  stone:   "#F5F0EA",
  warm:    "#EDE8E0",
  sidebar: "#0e0c0b",
  roseMid: "#C47080",
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

const OCCASIONS = ["All","Diwali","New Year","Birthday","Work Anniversary","Deal Milestone","Onboarding","Thank You","Corporate Event","Custom"];
const TIER_COLOR = { Platinum: C.cobalt, Gold: C.gold, Silver: C.muted };
const STATUS_STYLE = {
  tagged:       { bg: "#f0f8f0", color: "#3B6D11", label: "Tagged" },
  needs_review: { bg: "#FAEEDA", color: "#854F0B", label: "Needs review" },
  untagged:     { bg: "#F1EFE8", color: "#5F5E5A", label: "Untagged" },
};
const DIMENSIONS = [
  { key: "intent",          label: "Intent",           required: true  },
  { key: "audience",        label: "Audience",          required: true  },
  { key: "persona",         label: "Persona",           required: false },
  { key: "sensitivity",     label: "Sensitivity",       required: false },
  { key: "perceived_value", label: "Perceived value",   required: true  },
  { key: "usage",           label: "Usage",             required: false },
  { key: "functional",      label: "Functional",        required: true  },
  { key: "brand_signal",    label: "Brand signal",      required: true  },
  { key: "style",           label: "Style",             required: true  },
  { key: "emotional",       label: "Emotional outcome", required: false },
  { key: "occasion",        label: "Occasion",          required: false },
  { key: "sustainability",  label: "Sustainability",    required: false },
];

function getFulfillmentState(product, qty = 1) {
  const stock = product.stock_quantity ?? 100;
  const mtoMoq = product.mto_moq || product.moq || 1;
  if (stock >= 10 && stock >= qty) {
    return { state: "in_stock", label: "In stock", leadTime: product.lead_time || "2-3 working days", effectiveMoq: 1, customisable: false, belowMoq: false };
  }
  if (stock >= 1 && stock < 10) {
    return { state: "low_stock", label: "Low stock", leadTime: product.lead_time || "2-3 working days", effectiveMoq: 1, customisable: false, belowMoq: qty > stock };
  }
  return { state: "mto", label: "Made to order", leadTime: product.mto_lead_time || product.lead_time || "4-6 weeks", effectiveMoq: mtoMoq, customisable: true, belowMoq: qty < mtoMoq };
}

function priceAtQty(tiers, qty) {
  if (!tiers?.length) return 0;
  const match = tiers.filter(t => qty >= t.min_qty && (t.max_qty === null || qty <= t.max_qty)).sort((a,b) => b.min_qty - a.min_qty)[0];
  return match ? parseFloat(match.price_per_unit) : parseFloat(tiers[0].price_per_unit);
}

function scoreProduct(p, params) {
  const qty = parseInt(params.qty) || 1;
  const budget = parseFloat(params.budget) || Infinity;
  const fulfillment = getFulfillmentState(p, qty);
  let score = p.popularity || 0;
  const price = priceAtQty(p.pricing_tiers, qty);
  if (price <= budget) score += 30;
  else if (price <= budget * 1.1) score += 10;
  if (params.occasion && params.occasion !== "All") {
    if ((p.occasions || "").toLowerCase().includes(params.occasion.toLowerCase())) score += 25;
  } else score += 15;
  if (fulfillment.state === "in_stock") score += 20;
  else if (fulfillment.state === "low_stock") score += 15;
  else if (fulfillment.belowMoq) score -= 15;
  if (p.tier === "Platinum") score += 5;
  if (params.requireCustomisation && !fulfillment.customisable) score -= 50;
  return Math.min(100, Math.max(0, score));
}

export default function App() {
  const [tab, setTab] = useState("query");
  const [params, setParams] = useState({ budget:"", qty:"", days:"", occasion:"All", excludeEdible:false, excludeFragile:false, requireCustomisation:false });
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [showPreview, setShowPreview] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [clientName, setClientName] = useState("");
  const [showPdfMeta, setShowPdfMeta] = useState(false);
  const [sortBy, setSortBy] = useState("score");
  const [freeQuery, setFreeQuery] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [interpreted, setInterpreted] = useState(null);
  const [tagFilter, setTagFilter] = useState({ intent:"", audience:"", style:"", include_tags:[], exclude_tags:[] });
  const [excludeInput, setExcludeInput] = useState("");
  const [productTagMap, setProductTagMap] = useState({});
  const [tagLibrary, setTagLibrary] = useState({});
  const [adminView, setAdminView] = useState("list");
  const [editProduct, setEditProduct] = useState(null);
  const [saving, setSaving] = useState(false);
  const emptyForm = { name:"", category:"", price:"", tier:"Silver", image_url:"", occasions:"", description:"", edible:false, fragile:false, customisable:true, popularity:50, whats_in_box:[], box_dimensions:"", weight_grams:"", moq:"", lead_time:"", stock_quantity:"100", mto_moq:"", mto_lead_time:"" };
  const [form, setForm] = useState(emptyForm);
  const [boxItemInput, setBoxItemInput] = useState("");
  const [csvRows, setCsvRows] = useState([]);
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvStatus, setCsvStatus] = useState(null);
  const [tagProduct, setTagProduct] = useState(null);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState({});
  const [tagSelected, setTagSelected] = useState({});
  const [tagSaving, setTagSaving] = useState(false);
  const [tagSearches, setTagSearches] = useState({});
  const [customTags, setCustomTags] = useState({});
  const [newTags, setNewTags] = useState({});
  const queryTimer = useRef(null);

  const loadTagLibrary = useCallback(async () => {
    const { data } = await supabase.from("tag_library").select("tag, dimension");
    if (data) { const lib = {}; data.forEach(({ tag, dimension }) => { if (!lib[dimension]) lib[dimension] = []; lib[dimension].push(tag); }); setTagLibrary(lib); }
  }, []);

  const loadProductTags = useCallback(async () => {
    const { data } = await supabase.from("product_tags").select("product_id, tag, dimension").eq("human_confirmed", true);
    if (data) { const map = {}; data.forEach(({ product_id, tag, dimension }) => { if (!map[product_id]) map[product_id] = []; map[product_id].push({ tag, dimension }); }); setProductTagMap(map); }
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from("catalog").select("*, pricing_tiers(*)").eq("active", true).order("popularity", { ascending: false });
    if (!error) setProducts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadProducts(); loadTagLibrary(); loadProductTags(); }, [loadProducts, loadTagLibrary, loadProductTags]);

  const interpretQuery = useCallback(async (query) => {
    if (!query.trim()) { setInterpreted(null); setTagFilter({ intent:"", audience:"", style:"", include_tags:[], exclude_tags:[] }); return; }
    setQueryLoading(true);
    try {
      const res = await fetch(`${CATALOGUE_URL}/interpret-query`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ query }) });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setInterpreted(data);
      setTagFilter({ intent:data.intent||"", audience:data.audience||"", style:data.style||"", include_tags:data.include_tags||[], exclude_tags:data.exclude_tags||[] });
      if (data.occasion && data.occasion !== "all") { const match = OCCASIONS.find(o => o.toLowerCase() === data.occasion.toLowerCase()); if (match) setParams(p => ({ ...p, occasion: match })); }
    } catch (e) { /* silent */ }
    setQueryLoading(false);
  }, []);

  const clearSearch = () => { setFreeQuery(""); setInterpreted(null); setTagFilter({ intent:"", audience:"", style:"", include_tags:[], exclude_tags:[] }); };
  const addExcludeTag = (tag) => { const t = tag.toLowerCase().trim().replace(/\s+/g, "-"); if (!t || tagFilter.exclude_tags.includes(t)) return; setTagFilter(prev => ({ ...prev, exclude_tags: [...prev.exclude_tags, t] })); setExcludeInput(""); };
  const removeExcludeTag = (tag) => { setTagFilter(prev => ({ ...prev, exclude_tags: prev.exclude_tags.filter(t => t !== tag) })); };

  const tagScore = useCallback((productId) => {
    const pTags = productTagMap[productId] || [];
    const tagSet = new Set(pTags.map(t => t.tag));
    for (const ex of tagFilter.exclude_tags) { if (tagSet.has(ex)) return -1; }
    let boost = 0;
    if (tagFilter.intent && tagSet.has(tagFilter.intent)) boost += 30;
    if (tagFilter.audience && tagSet.has(tagFilter.audience)) boost += 25;
    if (tagFilter.style && tagSet.has(tagFilter.style)) boost += 20;
    for (const inc of tagFilter.include_tags) { if (tagSet.has(inc)) boost += 10; }
    return boost;
  }, [productTagMap, tagFilter]);

  const hasTagFilters = tagFilter.intent || tagFilter.audience || tagFilter.style || tagFilter.include_tags.length > 0 || tagFilter.exclude_tags.length > 0;

  const results = useMemo(() => {
    const qty = parseInt(params.qty) || 1;
    const budget = parseFloat(params.budget) || Infinity;
    return products.filter(p => {
      if (params.excludeEdible && p.edible) return false;
      if (params.excludeFragile && p.fragile) return false;
      const price = priceAtQty(p.pricing_tiers, qty);
      if (budget < Infinity && price > budget * 1.1) return false;
      if (hasTagFilters) {
        const pTags = productTagMap[p.id] || [];
        const tagSet = new Set(pTags.map(t => t.tag));
        for (const ex of tagFilter.exclude_tags) { if (tagSet.has(ex)) return false; }
        if (tagFilter.intent && !tagSet.has(tagFilter.intent)) return false;
        if (tagFilter.audience && !tagSet.has(tagFilter.audience)) return false;
        if (tagFilter.style && !tagSet.has(tagFilter.style)) return false;
      }
      const fulfillment = getFulfillmentState(p, qty);
      if (params.requireCustomisation && !fulfillment.customisable) return false;
      return true;
    }).map(p => {
      const fulfillment = getFulfillmentState(p, qty);
      const baseScore = scoreProduct(p, params);
      const tBoost = hasTagFilters ? tagScore(p.id) : 0;
      return { ...p, _score: Math.min(100, baseScore + tBoost), _price: priceAtQty(p.pricing_tiers, qty), _tagBoost: tBoost, _fulfillment: fulfillment };
    }).sort((a, b) => {
      if (sortBy === "score") return b._score - a._score;
      if (sortBy === "price_asc") return a._price - b._price;
      if (sortBy === "price_desc") return b._price - a._price;
      return 0;
    });
  }, [products, params, sortBy, tagScore, hasTagFilters]);

  useEffect(() => { if (results.length > 0) setSelected(new Set(results.filter(p => p._score >= 40).map(p => p.id))); }, [results]);

  const logRequest = useCallback(async (url) => {
    await supabase.from("client_requests").insert([{ budget_per_unit:parseFloat(params.budget)||null, quantity:parseInt(params.qty)||null, occasion:params.occasion!=="All"?params.occasion:null, exclude_edible:params.excludeEdible, exclude_fragile:params.excludeFragile, results_count:results.length, pdf_url:url||null }]);
  }, [params, results]);

  const generatePDF = async () => {
    const qty = parseInt(params.qty) || 1;
    const sel = results.filter(p => selected.has(p.id));
    if (!sel.length) return;
    setPdfLoading(true); setPdfUrl(null);
    try {
      const res = await fetch(`${CATALOGUE_URL}/generate-catalogue`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          products: sel.map(p => {
            const f = p._fulfillment || getFulfillmentState(p, qty);
            return { name:p.name, origin:p.category||"India", category:p.category||"General", price:Math.round(p._price), description:p.description||"", occasions:Array.isArray(p.occasions)?p.occasions:(p.occasions||"").split("|").map(s=>s.trim()).filter(Boolean), lead_time:f.leadTime, moq:f.effectiveMoq===1?"1 unit":`${f.effectiveMoq} units`, customisation:f.customisable?"Available on request":"Not available", images:p.image_url?[p.image_url]:[], whats_in_box:p.whats_in_box||[], box_dimensions:p.box_dimensions||"", weight_grams:p.weight_grams||null, stock_status:f.label };
          }),
          meta: { client_name:clientName||"Valued Client", occasion:params.occasion!=="All"?params.occasion:"Corporate Gifting", event_date:"", valid_until:"" },
        }),
      });
      if (!res.ok) throw new Error("Service returned "+res.status);
      const data = await res.json();
      if (data.storage_url) { setPdfUrl(data.storage_url); logRequest(data.storage_url); }
      if (data.pdf_base64) {
        const blob = new Blob([Uint8Array.from(atob(data.pdf_base64),c=>c.charCodeAt(0))],{type:"application/pdf"});
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href=url; a.download=data.filename||"catalogue.pdf"; a.click();
      }
    } catch(err) { alert("PDF generation failed: "+err.message); }
    finally { setPdfLoading(false); setShowPdfMeta(false); }
  };

  const openTagReview = async (product) => {
    setTagProduct(product); setTagSuggestions({}); setTagSelected({}); setTagSearches({}); setCustomTags({}); setNewTags({});
    setTagLoading(true);
    const { data: existingTags } = await supabase.from("product_tags").select("tag, dimension, confidence, human_confirmed").eq("product_id", product.id);
    try {
      const res = await fetch(`${CATALOGUE_URL}/auto-tag`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ product_id:product.id, name:product.name, category:product.category||"", description:product.description||"", tier:product.tier||"", occasions:product.occasions||"", price:product.price }) });
      if (!res.ok) throw new Error("Auto-tag failed: "+res.status);
      const data = await res.json();
      const grouped = {};
      data.tags.forEach(({tag,dimension,confidence}) => { if (!grouped[dimension]) grouped[dimension]=[]; grouped[dimension].push({tag,confidence}); });
      setTagSuggestions(grouped);
      const initSelected = {};
      DIMENSIONS.forEach(d => { initSelected[d.key] = new Set(); });
      data.tags.filter(t=>t.confidence>=70).forEach(({tag,dimension}) => { if (initSelected[dimension]) initSelected[dimension].add(tag); });
      if (existingTags) existingTags.filter(t=>t.human_confirmed).forEach(({tag,dimension}) => { if (initSelected[dimension]) initSelected[dimension].add(tag); });
      setTagSelected(initSelected);
    } catch(err) { alert("Auto-tag failed: "+err.message); setTagProduct(null); }
    setTagLoading(false);
  };

  const saveTags = async () => {
    if (!tagProduct) return;
    setTagSaving(true);
    try {
      await supabase.from("product_tags").delete().eq("product_id", tagProduct.id);
      const rows = [];
      DIMENSIONS.forEach(({key}) => { const sel = tagSelected[key] || new Set(); const suggestions = tagSuggestions[key] || []; sel.forEach(tag => { const s = suggestions.find(x=>x.tag===tag); rows.push({ product_id:tagProduct.id, tag, dimension:key, confidence:s?.confidence||100, ai_suggested:!!s, human_confirmed:true }); }); });
      if (rows.length) await supabase.from("product_tags").insert(rows);
      const newTagRows = [];
      DIMENSIONS.forEach(({key}) => { const nt = newTags[key]||new Set(); nt.forEach(tag => newTagRows.push({tag,dimension:key,created_by:"user"})); });
      if (newTagRows.length) { await supabase.from("tag_library").insert(newTagRows); loadTagLibrary(); }
      const required = ["intent","audience","perceived_value","brand_signal","style"];
      const allCovered = required.every(d => (tagSelected[d]?.size||0)>0);
      await supabase.from("catalog").update({ tagging_status:allCovered?"tagged":"needs_review", tagging_updated_at:new Date().toISOString() }).eq("id",tagProduct.id);
      setTagProduct(null); loadProducts(); loadProductTags();
    } catch(err) { alert("Save failed: "+err.message); }
    finally { setTagSaving(false); }
  };

  const toggleTag = (dimension, tag) => { setTagSelected(prev => { const next={...prev}; const s=new Set(next[dimension]||[]); s.has(tag)?s.delete(tag):s.add(tag); next[dimension]=s; return next; }); };
  const addCustomTag = (dimension, raw) => {
    const tag = raw.toLowerCase().trim().replace(/\s+/g,"-");
    if (!tag) return;
    setCustomTags(prev => { const n={...prev}; n[dimension]=[...(n[dimension]||[]),tag]; return n; });
    setNewTags(prev => { const n={...prev}; const s=new Set(n[dimension]||[]); s.add(tag); n[dimension]=s; return n; });
    setTagSelected(prev => { const n={...prev}; const s=new Set(n[dimension]||[]); s.add(tag); n[dimension]=s; return n; });
    setTagSearches(prev => ({...prev,[dimension]:""}));
  };
  const cfClass = c => c>=80?"high":c>=60?"med":"low";

  const saveProduct = async () => {
    if (!form.name||!form.price) return;
    setSaving(true);
    try {
      const payload = { name:form.name, category:form.category, price:parseFloat(form.price), tier:form.tier, image_url:form.image_url, occasions:form.occasions, description:form.description, edible:form.edible, fragile:form.fragile, customisable:form.customisable, popularity:parseInt(form.popularity)||50, lead_time:form.lead_time||null, active:true, whats_in_box:form.whats_in_box||[], box_dimensions:form.box_dimensions||null, weight_grams:form.weight_grams?parseInt(form.weight_grams):null, moq:form.moq?parseInt(form.moq):null, stock_quantity:form.stock_quantity!==''?parseInt(form.stock_quantity):100, mto_moq:form.mto_moq?parseInt(form.mto_moq):null, mto_lead_time:form.mto_lead_time||null };
      if (editProduct) {
        await supabase.from("catalog").update(payload).eq("id",editProduct.id);
      } else {
        const { data:ins } = await supabase.from("catalog").insert([payload]).select().single();
        if (ins) await supabase.from("pricing_tiers").insert([{product_id:ins.id,min_qty:1,max_qty:99,price_per_unit:parseFloat(form.price)},{product_id:ins.id,min_qty:100,max_qty:199,price_per_unit:parseFloat(form.price)*0.85},{product_id:ins.id,min_qty:200,max_qty:499,price_per_unit:parseFloat(form.price)*0.80},{product_id:ins.id,min_qty:500,max_qty:999,price_per_unit:parseFloat(form.price)*0.70},{product_id:ins.id,min_qty:1000,max_qty:null,price_per_unit:parseFloat(form.price)*0.60}]);
      }
      setForm(emptyForm); setEditProduct(null); setAdminView("list"); loadProducts();
    } catch(err) { alert("Save failed: "+err.message); }
    finally { setSaving(false); }
  };

  const parseCSV = (text) => {
    const lines = text.trim().split("\n");
    const headers = lines[0].split(",").map(h=>h.trim().replace(/^"|"$/g,""));
    return lines.slice(1).filter(l=>l.trim()).map(line => {
      const vals=[]; let cur="",inQ=false;
      for (const ch of line) { if(ch==='"'){inQ=!inQ;}else if(ch===","&&!inQ){vals.push(cur);cur="";}else cur+=ch; }
      vals.push(cur);
      const row={}; headers.forEach((h,i)=>{row[h]=(vals[i]||"").trim().replace(/^"|"$/g,"");}); return row;
    });
  };

  const handleCSVFile = (e) => { const file=e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=(ev)=>{setCsvRows(parseCSV(ev.target.result));setCsvStatus(null);}; reader.readAsText(file); };

  const uploadCSV = async () => {
    if (!csvRows.length) return;
    setCsvUploading(true); setCsvStatus(null);
    const errors=[]; let ok=0;
    for (const row of csvRows) {
      if (!row.name||!row.price){errors.push("Skipped: missing name or price");continue;}
      const bool=v=>v==="true"||v==="1"||v==="yes";
      const tierVal=row.tier||"Silver"; const p=parseFloat(row.price)||0;
      const payload={name:row.name,category:row.category||"",price:p,tier:tierVal,description:row.description||"",occasions:row.occasions||"",image_url:row.image_url||"",edible:bool(row.edible),fragile:bool(row.fragile),customisable:bool(row.customisable!==""?row.customisable:"true"),popularity:parseInt(row.popularity)||50,lead_time:row.lead_time||null,active:true,tagging_status:"untagged",whats_in_box:[],box_dimensions:row.box_dimensions||null,weight_grams:row.weight_grams?parseInt(row.weight_grams):null,moq:row.moq?parseInt(row.moq):null,stock_quantity:row.stock_quantity?parseInt(row.stock_quantity):100,mto_moq:row.mto_moq?parseInt(row.mto_moq):null,mto_lead_time:row.mto_lead_time||null};
      const {data:ins,error}=await supabase.from("catalog").insert([payload]).select().single();
      if(error){errors.push(row.name+": "+error.message);continue;}
      if(ins){
        await supabase.from("pricing_tiers").insert([{product_id:ins.id,min_qty:1,max_qty:99,price_per_unit:p},{product_id:ins.id,min_qty:100,max_qty:199,price_per_unit:p*0.85},{product_id:ins.id,min_qty:200,max_qty:499,price_per_unit:p*0.80},{product_id:ins.id,min_qty:500,max_qty:999,price_per_unit:p*0.70},{product_id:ins.id,min_qty:1000,max_qty:null,price_per_unit:p*0.60}]);
        fetch(`${CATALOGUE_URL}/auto-tag`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({product_id:ins.id,name:ins.name,category:ins.category||"",description:ins.description||"",tier:ins.tier||"",occasions:ins.occasions||"",price:ins.price})}).then(r=>r.json()).then(async(tagData)=>{if(!tagData.tags?.length)return;const tagRows=tagData.tags.map(t=>({product_id:ins.id,tag:t.tag,dimension:t.dimension,confidence:t.confidence,ai_suggested:true,human_confirmed:false}));await supabase.from("product_tags").insert(tagRows);await supabase.from("catalog").update({tagging_status:tagData.tagging_status,tagging_updated_at:new Date().toISOString()}).eq("id",ins.id);}).catch(()=>{});
        ok++;
      }
    }
    setCsvStatus({ok,errors}); setCsvUploading(false);
    if(ok>0){loadProducts();setCsvRows([]);}
  };

  const selectedProducts = results.filter(p=>selected.has(p.id));
  const totalBudget = selectedProducts.reduce((s,p)=>s+p._price*(parseInt(params.qty)||1),0);
  const totalTagSelected = Object.values(tagSelected).reduce((s,set)=>s+set.size,0);
  const newTagCount = Object.values(newTags).reduce((s,set)=>s+set.size,0);
  const intentOptions = tagLibrary["intent"] || [];
  const audienceOptions = tagLibrary["audience"] || [];
  const styleOptions = tagLibrary["style"] || [];

  const stockBadge = (f) => {
    if (f.state === "in_stock")  return { bg:"#f0f8f0", color:"#3B6D11" };
    if (f.state === "low_stock") return { bg:"#FAEEDA", color:"#854F0B" };
    return { bg:"#F1EFE8", color:"#5F5E5A" };
  };

  return (
    <>
      <style>{`
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
        html,body,#root{min-height:100vh;}
        body{background:${C.stone};font-family:'EB Garamond',serif;font-size:16px;color:${C.ink};}
        input,select,textarea,button{font-family:inherit;}
        .hdr{background:${C.sidebar};padding:0 40px;display:flex;align-items:center;justify-content:space-between;height:56px;}
        .hdr-brand{display:flex;align-items:baseline;gap:12px;}
        .hdr-name{font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:400;color:#fff;letter-spacing:1.5px;}
        .hdr-name em{font-style:italic;color:${C.blue};}
        .hdr-sub{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#888;}
        .hdr-tabs{display:flex;gap:2px;}
        .hdr-tab{padding:8px 20px;background:none;border:none;font-size:13px;letter-spacing:2.5px;text-transform:uppercase;color:#fff;cursor:pointer;opacity:0.4;border-bottom:2px solid transparent;font-weight:500;}
        .hdr-tab.on{opacity:1;border-bottom-color:${C.roseMid};}
        .layout{display:grid;grid-template-columns:300px 1fr;min-height:calc(100vh - 56px);}
        .sidebar{background:#fff;border-right:0.5px solid ${C.rule};padding:24px 20px;position:sticky;top:0;height:calc(100vh - 56px);overflow-y:auto;}
        .main{padding:28px 32px 60px;}
        .s-title{font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:${C.ink};letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;}
        .s-sub{font-size:12px;color:${C.muted};margin-bottom:20px;}
        .s-section{font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:${C.ink};font-weight:700;padding-bottom:7px;border-bottom:1.5px solid ${C.ink};margin-bottom:14px;margin-top:22px;}
        .s-field{margin-bottom:14px;}
        .s-label{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};display:block;margin-bottom:6px;}
        .s-inp{display:block;width:100%;padding:7px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-size:16px;font-style:italic;font-family:'Cormorant Garamond',serif;color:${C.ink};outline:none;}
        .s-inp:focus{border-bottom-color:${C.cobalt};}
        .s-sel{display:block;width:100%;padding:7px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-size:14px;color:${C.ink};outline:none;-webkit-appearance:none;cursor:pointer;}
        .s-toggle{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid ${C.rule};}
        .s-toggle:last-child{border-bottom:none;}
        .s-toggle-lbl{font-size:13px;color:${C.ink};}
        .s-toggle-sub{font-size:11px;color:${C.muted};}
        .s-chk{width:16px;height:16px;accent-color:${C.cobalt};cursor:pointer;flex-shrink:0;}
        .excl-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;}
        .excl-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:#FCEBEB;border:0.5px solid #F7C1C1;border-radius:99px;font-size:11px;color:#A32D2D;}
        .excl-chip button{background:none;border:none;color:#A32D2D;cursor:pointer;font-size:13px;line-height:1;padding:0;}
        .excl-inp{display:block;width:100%;padding:6px 0 7px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-size:14px;font-family:'Cormorant Garamond',serif;font-style:italic;color:${C.ink};outline:none;}
        .excl-inp:focus{border-bottom-color:${C.red};}
        .eyebrow{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};padding-bottom:8px;border-bottom:1.5px solid ${C.ink};margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;}
        .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1px;background:${C.rule};}
        .p-card{background:#fff;cursor:pointer;position:relative;transition:background 0.15s;}
        .p-card.sel{background:#F9F5F0;outline:2px solid ${C.ink};outline-offset:-2px;}
        .p-card:hover{background:#FDFAF7;}
        .p-img{width:100%;padding-bottom:133%;position:relative;overflow:hidden;background:${C.warm};}
        .p-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
        .p-img-emoji{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:52px;}
        .p-check{position:absolute;top:12px;right:12px;width:22px;height:22px;background:${C.ink};display:flex;align-items:center;justify-content:center;z-index:2;}
        .p-body{padding:16px 18px 18px;}
        .p-cat-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
        .p-cat{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};}
        .p-tier{font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border:0.5px solid;}
        .p-name{font-family:'Cormorant Garamond',serif;font-size:18px;line-height:1.3;color:${C.ink};margin-bottom:8px;}
        .p-desc{font-size:12px;color:${C.muted};line-height:1.55;margin-bottom:12px;}
        .p-price{font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:${C.ink};margin-bottom:4px;}
        .p-price-sub{font-size:11px;color:${C.muted};}
        .p-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center;}
        .p-badge{font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border:0.5px solid ${C.rule};color:${C.muted};}
        .p-badge-warn{font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;background:#FAEEDA;border:0.5px solid #c8a96e;color:#854F0B;border-radius:2px;}
        .p-score{position:absolute;top:12px;left:12px;background:rgba(14,12,11,0.75);color:#fff;font-size:10px;letter-spacing:1px;padding:3px 8px;}
        .p-tag-boost{position:absolute;top:36px;left:12px;background:#1D9E75;color:#fff;font-size:9px;letter-spacing:1px;padding:2px 7px;}
        .sort-bar{display:flex;gap:4px;}
        .sort-btn{padding:4px 12px;border:0.5px solid;font-size:10px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;background:transparent;}
        .sel-bar{background:${C.sidebar};padding:16px 32px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;position:sticky;bottom:0;z-index:50;}
        .sel-count{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:3px;}
        .sel-total{font-family:'Playfair Display',serif;font-size:26px;color:#fff;}
        .sel-qty{font-size:11px;color:#666;margin-top:2px;}
        .sel-btns{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
        .sel-btn-primary{padding:10px 24px;background:#fff;color:${C.sidebar};border:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;font-weight:500;}
        .sel-btn-sec{padding:10px 20px;background:transparent;color:#fff;border:1px solid #444;font-size:11px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;}
        .overlay{position:fixed;inset:0;background:rgba(26,22,20,0.7);display:flex;align-items:center;justify-content:center;z-index:200;}
        .overlay-box{background:${C.stone};border:0.5px solid ${C.rule};padding:36px;max-width:440px;width:90%;}
        .overlay-title{font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:${C.ink};margin-bottom:4px;}
        .overlay-sub{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};margin-bottom:24px;}
        .o-label{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.ink};display:block;margin-bottom:7px;}
        .o-inp{display:block;width:100%;padding:6px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-family:'Cormorant Garamond',serif;font-size:18px;font-style:italic;color:${C.ink};outline:none;margin-bottom:20px;}
        .o-inp:focus{border-bottom-color:${C.cobalt};}
        .o-btns{display:flex;gap:10px;margin-top:8px;}
        .o-btn-p{flex:1;padding:13px;background:${C.cobalt};border:none;color:#fff;font-size:12px;letter-spacing:3px;text-transform:uppercase;cursor:pointer;}
        .o-btn-s{padding:13px 18px;border:0.5px solid ${C.rule};background:transparent;color:${C.muted};font-size:12px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;}
        .admin-layout{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 56px);}
        .admin-side{background:#fff;border-right:0.5px solid ${C.rule};padding:24px 20px;}
        .admin-main{padding:28px 36px 60px;background:${C.stone};}
        .admin-s-title{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};margin-bottom:14px;}
        .admin-s-item{display:block;width:100%;text-align:left;padding:9px 12px;background:none;border:none;border-left:2px solid transparent;font-size:14px;color:${C.ink};cursor:pointer;margin-bottom:2px;}
        .admin-s-item.on{border-left-color:${C.roseMid};background:${C.stone};font-weight:500;}
        .admin-s-item:hover{background:${C.stone};}
        .admin-eyebrow{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};padding-bottom:8px;border-bottom:1.5px solid ${C.ink};margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;}
        .admin-tbl{width:100%;border-collapse:collapse;}
        .admin-th{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};padding:0 12px 10px;text-align:left;border-bottom:1px solid ${C.ink};font-weight:400;}
        .admin-td{font-size:14px;color:${C.ink};padding:11px 12px;border-bottom:0.5px solid ${C.rule};vertical-align:middle;font-family:'Cormorant Garamond',serif;}
        .admin-td-sm{font-family:'EB Garamond',serif;font-size:12px;}
        .admin-act{font-family:'EB Garamond',serif;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:3px 10px;border:0.5px solid;background:transparent;cursor:pointer;}
        .loading{display:flex;align-items:center;justify-content:center;min-height:300px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};}
        .pf-wrap{max-width:720px;}
        .pf-card{background:#fff;border:0.5px solid ${C.rule};margin-bottom:2px;}
        .pf-card-head{padding:14px 20px;border-bottom:0.5px solid ${C.rule};display:flex;align-items:center;gap:10px;}
        .pf-card-num{width:22px;height:22px;background:${C.ink};color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
        .pf-card-title{font-size:10px;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;color:${C.ink};}
        .pf-card-body{padding:20px;}
        .pf-row{display:grid;gap:20px;margin-bottom:18px;}
        .pf-row-1{grid-template-columns:1fr;}
        .pf-row-2{grid-template-columns:1fr 1fr;}
        .pf-row-3{grid-template-columns:1fr 1fr 1fr;}
        .pf-field{display:flex;flex-direction:column;gap:5px;}
        .pf-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};}
        .pf-inp{padding:7px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-family:'Cormorant Garamond',serif;font-size:16px;color:${C.ink};outline:none;width:100%;}
        .pf-inp:focus{border-bottom-color:${C.cobalt};}
        .pf-sel{padding:7px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-family:'EB Garamond',serif;font-size:15px;color:${C.ink};outline:none;-webkit-appearance:none;cursor:pointer;width:100%;}
        .pf-ta{padding:7px 0 8px;background:transparent;border:none;border-bottom:1px solid ${C.rule};font-family:'Cormorant Garamond',serif;font-size:15px;color:${C.ink};outline:none;resize:none;width:100%;line-height:1.5;}
        .pf-hint{font-size:10px;color:${C.muted};}
        .pf-toggle-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:0.5px solid ${C.rule};}
        .pf-toggle-row:last-child{border-bottom:none;}
        .pf-toggle-lbl{font-size:13px;color:${C.ink};}
        .pf-toggle-sub{font-size:11px;color:${C.muted};margin-top:1px;}
        .pf-actions{display:flex;gap:10px;margin-top:24px;}
        .pf-save{padding:12px 32px;background:${C.cobalt};border:none;color:#fff;font-size:11px;letter-spacing:3px;text-transform:uppercase;cursor:pointer;}
        .pf-save:disabled{opacity:0.6;cursor:not-allowed;}
        .pf-cancel{padding:12px 20px;border:0.5px solid ${C.rule};background:transparent;color:${C.muted};font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;}
        .pf-required{color:${C.roseMid};}
        .status-badge{font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:99px;font-weight:700;}
        .tag-overlay{position:fixed;inset:0;background:rgba(26,22,20,0.65);z-index:300;display:flex;align-items:stretch;justify-content:flex-end;}
        .tag-panel{background:${C.stone};width:min(680px,100vw);display:flex;flex-direction:column;overflow:hidden;}
        .tag-panel-head{background:${C.sidebar};padding:20px 28px;flex-shrink:0;}
        .tag-panel-name{font-family:'Cormorant Garamond',serif;font-size:22px;color:#fff;font-weight:300;margin-bottom:3px;}
        .tag-panel-meta{font-size:11px;color:#888;letter-spacing:1px;}
        .tag-panel-body{flex:1;overflow-y:auto;padding:20px 28px;}
        .tag-panel-foot{background:#fff;border-top:0.5px solid ${C.rule};padding:16px 28px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;}
        .tag-dim-card{background:#fff;border:0.5px solid ${C.rule};margin-bottom:8px;}
        .tag-dim-head{padding:10px 14px;border-bottom:0.5px solid ${C.rule};display:flex;align-items:center;gap:8px;}
        .tag-dim-label{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink};flex:1;}
        .tag-dim-req{font-size:10px;background:#FCEBEB;color:#A32D2D;padding:2px 7px;border-radius:99px;}
        .tag-dim-count{font-size:11px;color:${C.muted};}
        .tag-dim-body{padding:10px 14px;display:flex;flex-wrap:wrap;gap:6px;}
        .tag-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:99px;border:0.5px solid ${C.rule};font-size:12px;cursor:pointer;user-select:none;background:#fff;color:${C.ink};}
        .tag-chip:hover{background:${C.stone};}
        .tag-chip.sel{background:#E1F5EE;border-color:#1D9E75;color:#085041;}
        .tag-chip.new-t{background:#E6F1FB;border-color:#378ADD;color:#042C53;}
        .tag-cf{font-size:10px;font-weight:500;padding:1px 5px;border-radius:99px;background:${C.warm};color:${C.muted};}
        .tag-cf.high{background:#9FE1CB;color:#085041;}
        .tag-cf.med{background:#FAC775;color:#412402;}
        .tag-new-badge{font-size:10px;background:#E6F1FB;color:#185FA5;padding:1px 6px;border-radius:99px;}
        .tag-search-row{padding:8px 14px 12px;position:relative;}
        .tag-search-inp{width:100%;padding:6px 12px;border:0.5px solid ${C.rule};border-radius:4px;font-size:13px;background:${C.stone};color:${C.ink};outline:none;box-sizing:border-box;}
        .tag-search-inp:focus{border-color:${C.cobalt};background:#fff;}
        .tag-drop{position:absolute;left:14px;right:14px;background:#fff;border:0.5px solid ${C.rule};z-index:10;margin-top:2px;}
        .tag-drop-item{padding:8px 12px;font-size:13px;cursor:pointer;color:${C.ink};}
        .tag-drop-item:hover{background:${C.stone};}
        .tag-drop-create{padding:8px 12px;font-size:13px;cursor:pointer;color:${C.cobalt};font-weight:500;display:flex;align-items:center;gap:6px;border-top:0.5px solid ${C.rule};}
        .tag-drop-create:hover{background:#E6F1FB;}
        .tag-loading{display:flex;align-items:center;justify-content:center;min-height:200px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.muted};}
        .f-label{font-size:9px;letter-spacing:2.5px;text-transform:uppercase;color:${C.muted};display:block;margin-bottom:8px;}
        .f-save{padding:11px 28px;background:${C.cobalt};border:none;color:#fff;font-size:11px;letter-spacing:3px;text-transform:uppercase;cursor:pointer;}
      `}</style>

      <div className="hdr">
        <div className="hdr-brand">
          <div className="hdr-name">Ikka &thinsp;<em>Dukka</em></div>
          <div className="hdr-sub">Catalogue Engine</div>
        </div>
        <div className="hdr-tabs">
          {[["query","Query"],["admin","Admin"]].map(([k,l])=>(
            <button key={k} className={`hdr-tab${tab===k?" on":""}`} onClick={()=>setTab(k)}>{l}</button>
          ))}
        </div>
      </div>

      {tab==="query" && (
        <div className="layout">
          <div className="sidebar">
            <div className="s-title">Find gifts</div>
            <div className="s-sub">Describe what you need or use the filters below.</div>
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <input type="text" placeholder="e.g. festive gifts for CXOs..." value={freeQuery} onChange={e=>setFreeQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")interpretQuery(freeQuery);}} style={{flex:1,padding:"9px 10px",background:"#F5F0EA",border:"1px solid #C8B8B0",borderRadius:4,fontSize:14,fontFamily:"'EB Garamond',serif",color:"#1A1614",outline:"none",minWidth:0,display:"block"}}/>
                {freeQuery&&<button onClick={clearSearch} style={{background:"none",border:"none",color:"#8A7A72",cursor:"pointer",fontSize:18,padding:"0 4px",lineHeight:1,flexShrink:0}}>×</button>}
              </div>
              <button onClick={()=>interpretQuery(freeQuery)} disabled={!freeQuery.trim()||queryLoading} style={{display:"block",width:"100%",marginTop:6,padding:"8px",background:queryLoading?"#8A7A72":"#1A1614",color:"#fff",border:"none",fontSize:10,letterSpacing:2,textTransform:"uppercase",cursor:!freeQuery.trim()||queryLoading?"not-allowed":"pointer",opacity:!freeQuery.trim()?0.4:1,fontFamily:"inherit"}}>
                {queryLoading?"Interpreting…":"Search →"}
              </button>
              {interpreted&&!queryLoading&&(
                <div style={{display:"flex",alignItems:"center",gap:6,background:"#E1F5EE",border:"0.5px solid #1D9E75",color:"#085041",padding:"5px 10px",borderRadius:99,fontSize:11,marginTop:8}}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#1D9E75" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,6 5,9 10,3"/></svg>
                  <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{interpreted.summary}</span>
                </div>
              )}
            </div>

            <div className="s-section">Budget & Quantity</div>
            <div className="s-field"><label className="s-label">Budget per unit (₹)</label><input className="s-inp" type="number" placeholder="e.g. 3000" value={params.budget} onChange={e=>setParams(p=>({...p,budget:e.target.value}))}/></div>
            <div className="s-field">
              <label className="s-label">Quantity (units)</label>
              <input className="s-inp" type="number" placeholder="e.g. 100" value={params.qty} onChange={e=>setParams(p=>({...p,qty:e.target.value}))}/>
              {params.qty&&parseInt(params.qty)>=100&&<div style={{fontSize:11,color:"#5a8a5a",marginTop:4}}>Volume pricing applies from 100+ units</div>}
            </div>

            <div className="s-section">Timeline & Occasion</div>
            <div className="s-field"><label className="s-label">Days until event</label><input className="s-inp" type="number" placeholder="e.g. 21" value={params.days} onChange={e=>setParams(p=>({...p,days:e.target.value}))}/></div>
            <div className="s-field"><label className="s-label">Occasion</label><select className="s-sel" value={params.occasion} onChange={e=>setParams(p=>({...p,occasion:e.target.value}))}>{OCCASIONS.map(o=><option key={o}>{o}</option>)}</select></div>

            <div className="s-section">Restrictions</div>
            {[{key:"excludeEdible",label:"Exclude edible items",sub:"No food or beverage products"},{key:"excludeFragile",label:"Exclude fragile items",sub:"Safe for courier / bulk shipping"}].map(r=>(
              <div className="s-toggle" key={r.key}>
                <div><div className="s-toggle-lbl">{r.label}</div><div className="s-toggle-sub">{r.sub}</div></div>
                <input type="checkbox" className="s-chk" checked={params[r.key]} onChange={e=>setParams(p=>({...p,[r.key]:e.target.checked}))}/>
              </div>
            ))}
            <div className="s-toggle">
              <div><div className="s-toggle-lbl">Customisation required</div><div className="s-toggle-sub">Only show made-to-order products</div></div>
              <input type="checkbox" className="s-chk" checked={params.requireCustomisation} onChange={e=>setParams(p=>({...p,requireCustomisation:e.target.checked}))}/>
            </div>

            <div className="s-section">Smart Filters</div>
            <div className="s-field"><label className="s-label">Intent</label><select className="s-sel" value={tagFilter.intent} onChange={e=>setTagFilter(prev=>({...prev,intent:e.target.value}))}><option value="">Any intent</option>{intentOptions.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
            <div className="s-field"><label className="s-label">Audience</label><select className="s-sel" value={tagFilter.audience} onChange={e=>setTagFilter(prev=>({...prev,audience:e.target.value}))}><option value="">Any audience</option>{audienceOptions.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
            <div className="s-field"><label className="s-label">Style</label><select className="s-sel" value={tagFilter.style} onChange={e=>setTagFilter(prev=>({...prev,style:e.target.value}))}><option value="">Any style</option>{styleOptions.map(t=><option key={t} value={t}>{t}</option>)}</select></div>
            <div className="s-field">
              <label className="s-label">Exclude tags</label>
              {tagFilter.exclude_tags.length>0&&(<div className="excl-chips">{tagFilter.exclude_tags.map(t=>(<span key={t} className="excl-chip">{t}<button onClick={()=>removeExcludeTag(t)}>×</button></span>))}</div>)}
              <input className="excl-inp" type="text" placeholder="e.g. leather, alcohol…" value={excludeInput} onChange={e=>setExcludeInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"||e.key===","||e.key===" "){e.preventDefault();addExcludeTag(excludeInput);}}}/>
              <div style={{fontSize:10,color:"#8A7A72",marginTop:3}}>Press Enter or comma to add</div>
            </div>

            <div className="s-section">Sort Results By</div>
            <select className="s-sel" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
              <option value="score">Best match (AI scored)</option>
              <option value="price_asc">Price low → high</option>
              <option value="price_desc">Price high → low</option>
            </select>

            <div style={{marginTop:20,padding:"14px 0",borderTop:"0.5px solid #C8B8B0"}}>
              <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"#8A7A72",marginBottom:6}}>Results</div>
              <div style={{fontFamily:"'Playfair Display',serif",fontSize:28,fontWeight:900,color:"#1A1614"}}>{results.length}</div>
              <div style={{fontSize:12,color:"#8A7A72"}}>products matched · {selected.size} selected</div>
              {hasTagFilters&&<div style={{fontSize:11,color:"#5a8a5a",marginTop:4}}>Tag filters active</div>}
              {params.requireCustomisation&&<div style={{fontSize:11,color:C.amber,marginTop:4}}>Customisation filter on — MTO only</div>}
            </div>
          </div>

          <div className="main">
            {loading?<div className="loading">Loading catalogue…</div>:(
              <>
                <div className="eyebrow">
                  <span>{results.length} products{hasTagFilters?" · filtered by tags":""}</span>
                  <div className="sort-bar">{[["score","Best Match"],["price_asc","Price ↑"],["price_desc","Price ↓"]].map(([v,l])=>(<button key={v} onClick={()=>setSortBy(v)} className="sort-btn" style={{borderColor:sortBy===v?C.ink:C.rule,color:sortBy===v?C.ink:C.muted}}>{l}</button>))}</div>
                </div>
                {results.length===0?<div className="loading">No products match — try adjusting your filters</div>:(
                  <div className="product-grid">
                    {results.map(p=>{
                      const isSel = selected.has(p.id);
                      const tierC = TIER_COLOR[p.tier]||C.muted;
                      const f     = p._fulfillment || getFulfillmentState(p, parseInt(params.qty)||1);
                      const sb    = stockBadge(f);
                      return (
                        <div key={p.id} className={`p-card${isSel?" sel":""}`} onClick={()=>setSelected(prev=>{const n=new Set(prev);n.has(p.id)?n.delete(p.id):n.add(p.id);return n;})}>
                          <div className="p-score">{p._score}% match</div>
                          {p._tagBoost>0&&<div className="p-tag-boost">tag match</div>}
                          {isSel&&<div className="p-check"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2,6 5,9 10,3"/></svg></div>}
                          <div className="p-img">{p.image_url?.startsWith("http")?<img src={p.image_url} alt={p.name}/>:<div className="p-img-emoji">{p.fb_icon||"🎁"}</div>}</div>
                          <div className="p-body">
                            <div className="p-cat-row"><div className="p-cat">{p.category}</div><span className="p-tier" style={{color:tierC,borderColor:tierC}}>{p.tier}</span></div>
                            <div className="p-name">{p.name}</div>
                            {p.description&&<div className="p-desc">{p.description.slice(0,90)}{p.description.length>90?"…":""}</div>}
                            <div className="p-price">₹{p._price.toLocaleString("en-IN")}</div>
                            <div className="p-price-sub">per unit{params.qty&&parseInt(params.qty)>=100?" · volume price":" · retail"}</div>
                            {params.qty&&<div style={{fontSize:12,color:C.muted,marginTop:3}}>{params.qty} units = ₹{(p._price*parseInt(params.qty)).toLocaleString("en-IN")}</div>}
                            <div className="p-meta">
                              <span className="status-badge" style={{background:sb.bg,color:sb.color}}>{f.label}</span>
                              {f.belowMoq&&<span className="p-badge-warn">Min. {f.effectiveMoq} units</span>}
                              {f.customisable&&<span className="p-badge">Customisable</span>}
                              {p.edible&&<span className="p-badge">Edible</span>}
                              {p.fragile&&<span className="p-badge">Fragile</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {selected.size>0&&(
                  <div className="sel-bar">
                    <div>
                      <div className="sel-count">{selected.size} product{selected.size>1?"s":""} selected</div>
                      <div className="sel-total">₹{totalBudget.toLocaleString("en-IN")}</div>
                      <div className="sel-qty">{params.qty||1} units × {selected.size} products</div>
                    </div>
                    <div className="sel-btns">
                      <button className="sel-btn-sec" onClick={()=>setShowPreview(v=>!v)}>{showPreview?"Hide preview":"Preview catalogue"}</button>
                      <button className="sel-btn-primary" onClick={()=>setShowPdfMeta(true)}>Generate PDF →</button>
                      {pdfUrl&&<a href={pdfUrl} target="_blank" rel="noreferrer" style={{color:C.blue,fontSize:12}}>View PDF ↗</a>}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {tab==="admin"&&(
        <div className="admin-layout">
          <div className="admin-side">
            <div className="admin-s-title">Admin Panel</div>
            {[["list","All Products"],["add","Add Product"],["csv","Bulk Upload CSV"]].map(([k,l])=>(
              <button key={k} className={`admin-s-item${adminView===k?" on":""}`} onClick={()=>{setAdminView(k);setEditProduct(null);setForm(emptyForm);}}>{l}</button>
            ))}
          </div>
          <div className="admin-main">
            {adminView==="list"&&(
              <>
                <div className="admin-eyebrow">
                  <span>All Products — {products.length} items</span>
                  <span style={{fontSize:11,color:C.muted}}>{products.filter(p=>p.tagging_status==="needs_review").length} need review · {products.filter(p=>!p.tagging_status||p.tagging_status==="untagged").length} untagged</span>
                </div>
                <div style={{background:"#fff",border:`0.5px solid ${C.rule}`,overflowX:"auto"}}>
                  <table className="admin-tbl">
                    <thead><tr>{["Name","Category","Price","Stock","Tier","Tags","Actions"].map((h,i)=><th className="admin-th" key={i}>{h}</th>)}</tr></thead>
                    <tbody>
                      {products.map(p=>{
                        const st = STATUS_STYLE[p.tagging_status]||STATUS_STYLE.untagged;
                        const f  = getFulfillmentState(p, 1);
                        const sb = stockBadge(f);
                        return (
                          <tr key={p.id}>
                            <td className="admin-td">{p.name}</td>
                            <td className="admin-td admin-td-sm">{p.category}</td>
                            <td className="admin-td admin-td-sm">₹{parseFloat(p.price).toLocaleString("en-IN")}</td>
                            <td className="admin-td">
                              <span className="status-badge" style={{background:sb.bg,color:sb.color}}>{f.label}</span>
                              <div style={{fontSize:10,color:C.muted,marginTop:2}}>{p.stock_quantity??100} units</div>
                            </td>
                            <td className="admin-td"><span style={{fontSize:10,letterSpacing:1,textTransform:"uppercase",padding:"2px 8px",border:`0.5px solid ${TIER_COLOR[p.tier]||C.muted}`,color:TIER_COLOR[p.tier]||C.muted}}>{p.tier}</span></td>
                            <td className="admin-td"><span className="status-badge" style={{background:st.bg,color:st.color}}>{st.label}</span></td>
                            <td className="admin-td" style={{display:"flex",gap:6}}>
                              <button className="admin-act" style={{borderColor:C.green,color:C.green}} onClick={()=>openTagReview(p)}>Tag →</button>
                              <button className="admin-act" style={{borderColor:C.cobalt,color:C.cobalt}} onClick={()=>{setEditProduct(p);setForm({name:p.name,category:p.category||"",price:String(p.price),tier:p.tier||"Silver",image_url:p.image_url||"",occasions:p.occasions||"",description:p.description||"",edible:p.edible||false,fragile:p.fragile||false,customisable:p.customisable!==false,popularity:p.popularity||50,whats_in_box:p.whats_in_box||[],box_dimensions:p.box_dimensions||"",weight_grams:p.weight_grams?String(p.weight_grams):"",moq:p.moq?String(p.moq):"",lead_time:p.lead_time||"",stock_quantity:p.stock_quantity!=null?String(p.stock_quantity):"100",mto_moq:p.mto_moq?String(p.mto_moq):"",mto_lead_time:p.mto_lead_time||""});setAdminView("edit");}}>Edit →</button>
                              <button className="admin-act" style={{borderColor:C.red,color:C.red}} onClick={async()=>{if(window.confirm(`Delete ${p.name}?`)){await supabase.from("product_tags").delete().eq("product_id",p.id);await supabase.from("pricing_tiers").delete().eq("product_id",p.id);await supabase.from("catalog").delete().eq("id",p.id);loadProducts();}}}>Delete</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {(adminView==="add"||adminView==="edit")&&(
              <div className="pf-wrap">
                <div className="admin-eyebrow">{editProduct?`Editing — ${editProduct.name}`:"Add New Product"}</div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">1</div><div className="pf-card-title">Core Details</div></div>
                  <div className="pf-card-body">
                    <div className="pf-row pf-row-1"><div className="pf-field"><label className="pf-label">Product Name <span className="pf-required">*</span></label><input className="pf-inp" type="text" placeholder="e.g. Kashmiri Kahwa Gift Set" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}/></div></div>
                    <div className="pf-row pf-row-2">
                      <div className="pf-field"><label className="pf-label">Category</label><input className="pf-inp" type="text" placeholder="e.g. Artisanal Teas" value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))}/></div>
                      <div className="pf-field"><label className="pf-label">Tier</label><select className="pf-sel" value={form.tier} onChange={e=>setForm(p=>({...p,tier:e.target.value}))}>{["Silver","Gold","Platinum"].map(t=><option key={t}>{t}</option>)}</select></div>
                    </div>
                    <div className="pf-row pf-row-1"><div className="pf-field"><label className="pf-label">Description</label><textarea className="pf-ta" rows={2} placeholder="Short product description…" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}/></div></div>
                  </div>
                </div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">2</div><div className="pf-card-title">Pricing</div></div>
                  <div className="pf-card-body">
                    <div className="pf-row pf-row-2">
                      <div className="pf-field"><label className="pf-label">Base Price (₹) <span className="pf-required">*</span></label><input className="pf-inp" type="number" placeholder="e.g. 2500" value={form.price} onChange={e=>setForm(p=>({...p,price:e.target.value}))}/><div className="pf-hint">Volume tiers auto-generated.</div></div>
                      <div className="pf-field"><label className="pf-label">Popularity (0–100)</label><input className="pf-inp" type="number" min="0" max="100" value={form.popularity} onChange={e=>setForm(p=>({...p,popularity:e.target.value}))}/></div>
                    </div>
                    {form.price&&(<div style={{display:"flex",gap:1,marginTop:4}}>{[["1–99",1],["100–199",0.85],["200–499",0.80],["500–999",0.70],["1000+",0.60]].map(([label,mult])=>(<div key={label} style={{flex:1,background:C.stone,padding:"8px 10px",borderRight:`0.5px solid ${C.rule}`}}><div style={{fontSize:9,color:C.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{label}</div><div style={{fontFamily:"'Playfair Display',serif",fontSize:13,fontWeight:700,color:C.ink}}>₹{Math.round(parseFloat(form.price)*mult).toLocaleString("en-IN")}</div></div>))}</div>)}
                  </div>
                </div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">3</div><div className="pf-card-title">Availability & Occasions</div></div>
                  <div className="pf-card-body">
                    <div className="pf-row pf-row-1"><div className="pf-field"><label className="pf-label">Occasions</label><input className="pf-inp" type="text" placeholder="e.g. Diwali|Birthday|Thank You" value={form.occasions} onChange={e=>setForm(p=>({...p,occasions:e.target.value}))}/><div className="pf-hint">Separate with | (pipe).</div></div></div>
                    <div className="pf-row pf-row-1"><div className="pf-field"><label className="pf-label">Image URL</label><input className="pf-inp" type="text" placeholder="https://…" value={form.image_url} onChange={e=>setForm(p=>({...p,image_url:e.target.value}))}/>{form.image_url?.startsWith("http")&&<img src={form.image_url} alt="" style={{marginTop:8,height:56,width:56,objectFit:"cover",border:`0.5px solid ${C.rule}`}}/>}</div></div>
                  </div>
                </div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">4</div><div className="pf-card-title">Attributes</div></div>
                  <div className="pf-card-body" style={{paddingTop:8,paddingBottom:8}}>
                    {[{key:"edible",label:"Edible / food product",sub:"Excluded when client restricts edible gifts"},{key:"fragile",label:"Fragile item",sub:"Excluded when client restricts fragile gifts"},{key:"customisable",label:"Available for customisation",sub:"Branding, engraving, message cards etc."}].map(a=>(<div className="pf-toggle-row" key={a.key}><div><div className="pf-toggle-lbl">{a.label}</div><div className="pf-toggle-sub">{a.sub}</div></div><input type="checkbox" className="s-chk" checked={form[a.key]} onChange={e=>setForm(p=>({...p,[a.key]:e.target.checked}))}/></div>))}
                  </div>
                </div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">5</div><div className="pf-card-title">Logistics & Corporate Info</div></div>
                  <div className="pf-card-body">
                    <div className="pf-row pf-row-1">
                      <div className="pf-field">
                        <label className="pf-label">What's in the box</label>
                        {(form.whats_in_box||[]).length>0&&(<div style={{marginBottom:8,display:"flex",flexDirection:"column",gap:4}}>{form.whats_in_box.map((item,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:C.ink}}><span style={{color:C.muted}}>—</span><span style={{flex:1}}>{item}</span><button onClick={()=>setForm(p=>({...p,whats_in_box:p.whats_in_box.filter((_,j)=>j!==i)}))} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,lineHeight:1,padding:0}}>×</button></div>))}</div>)}
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <input className="pf-inp" type="text" placeholder="e.g. Brass figurine" style={{flex:1}} value={boxItemInput} onChange={e=>setBoxItemInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&boxItemInput.trim()){e.preventDefault();setForm(p=>({...p,whats_in_box:[...(p.whats_in_box||[]),boxItemInput.trim()]}));setBoxItemInput("");}}}/>
                          <button onClick={()=>{if(boxItemInput.trim()){setForm(p=>({...p,whats_in_box:[...(p.whats_in_box||[]),boxItemInput.trim()]}));setBoxItemInput("");}}} style={{padding:"6px 14px",background:C.ink,border:"none",color:"#fff",fontSize:11,letterSpacing:1,textTransform:"uppercase",cursor:"pointer",flexShrink:0,fontFamily:"inherit"}}>Add</button>
                        </div>
                        <div className="pf-hint">Press Enter or click Add after each item.</div>
                      </div>
                    </div>
                    <div className="pf-row pf-row-2">
                      <div className="pf-field"><label className="pf-label">Box dimensions</label><input className="pf-inp" type="text" placeholder="e.g. 20 × 15 × 10 cm" value={form.box_dimensions} onChange={e=>setForm(p=>({...p,box_dimensions:e.target.value}))}/></div>
                      <div className="pf-field"><label className="pf-label">Weight (grams)</label><input className="pf-inp" type="number" placeholder="e.g. 450" value={form.weight_grams} onChange={e=>setForm(p=>({...p,weight_grams:e.target.value}))}/></div>
                    </div>
                    <div className="pf-row pf-row-2">
                      <div className="pf-field"><label className="pf-label">Display MOQ</label><input className="pf-inp" type="number" placeholder="e.g. 25" value={form.moq} onChange={e=>setForm(p=>({...p,moq:e.target.value}))}/><div className="pf-hint">Shown on product card.</div></div>
                      <div className="pf-field"><label className="pf-label">In-stock lead time</label><input className="pf-inp" type="text" placeholder="e.g. 7–10 working days" value={form.lead_time} onChange={e=>setForm(p=>({...p,lead_time:e.target.value}))}/></div>
                    </div>
                  </div>
                </div>
                <div className="pf-card">
                  <div className="pf-card-head"><div className="pf-card-num">6</div><div className="pf-card-title">Stock & Fulfilment</div></div>
                  <div className="pf-card-body">
                    <div className="pf-row pf-row-3">
                      <div className="pf-field">
                        <label className="pf-label">Stock on hand</label>
                        <input className="pf-inp" type="number" min="0" placeholder="e.g. 100" value={form.stock_quantity} onChange={e=>setForm(p=>({...p,stock_quantity:e.target.value}))}/>
                        <div className="pf-hint" style={{color:parseInt(form.stock_quantity)>=10?C.green:parseInt(form.stock_quantity)>0?C.amber:C.red}}>
                          {parseInt(form.stock_quantity)>=10?"In stock":parseInt(form.stock_quantity)>0?"Low stock":"Made to order"}
                        </div>
                      </div>
                      <div className="pf-field"><label className="pf-label">MTO min. order qty</label><input className="pf-inp" type="number" min="0" placeholder="e.g. 50" value={form.mto_moq} onChange={e=>setForm(p=>({...p,mto_moq:e.target.value}))}/><div className="pf-hint">Min. for a production run.</div></div>
                      <div className="pf-field"><label className="pf-label">MTO lead time</label><input className="pf-inp" type="text" placeholder="e.g. 4–6 weeks" value={form.mto_lead_time} onChange={e=>setForm(p=>({...p,mto_lead_time:e.target.value}))}/><div className="pf-hint">When stock = 0.</div></div>
                    </div>
                    {form.stock_quantity!==''&&(
                      <div style={{marginTop:4,padding:"10px 14px",background:C.stone,borderLeft:`2px solid ${C.rule}`,fontSize:12,color:C.muted}}>
                        <strong style={{color:C.ink}}>State: </strong>
                        {parseInt(form.stock_quantity)>=10?`In stock — MOQ 1, lead time: ${form.lead_time||"2–3 working days"}, no customisation`:parseInt(form.stock_quantity)>0?`Low stock (${form.stock_quantity} units)`:`Made to order — MOQ ${form.mto_moq||"?"}, lead time: ${form.mto_lead_time||"?"}, customisation available`}
                      </div>
                    )}
                  </div>
                </div>
                <div className="pf-actions">
                  <button className="pf-cancel" onClick={()=>{setAdminView("list");setEditProduct(null);setForm(emptyForm);}}>Cancel</button>
                  <button className="pf-save" onClick={saveProduct} disabled={saving||!form.name||!form.price}>{saving?"Saving…":editProduct?"Save Changes →":"Add Product →"}</button>
                </div>
              </div>
            )}
            {adminView==="csv"&&(
              <>
                <div className="admin-eyebrow">Bulk Upload — CSV</div>
                <div style={{maxWidth:640}}>
                  <div style={{background:"#fff",border:`0.5px solid ${C.rule}`,padding:"20px 24px",marginBottom:16}}>
                    <div style={{fontFamily:"'Playfair Display',serif",fontSize:14,fontWeight:700,color:C.ink,marginBottom:6}}>CSV Format</div>
                    <div style={{fontFamily:"'EB Garamond',serif",fontSize:13,color:C.muted,lineHeight:1.7}}>Required: <strong>name, price</strong><br/>Optional: category, tier, description, occasions (pipe-separated), image_url, edible, fragile, customisable, popularity, lead_time, moq, box_dimensions, weight_grams, stock_quantity, mto_moq, mto_lead_time</div>
                  </div>
                  <div style={{marginBottom:20}}><label className="f-label">Select CSV file</label><input type="file" accept=".csv" onChange={handleCSVFile} style={{display:"block",width:"100%",padding:"8px 0",fontFamily:"'EB Garamond',serif",fontSize:14,color:C.ink,borderBottom:`1px solid ${C.rule}`,background:"transparent",outline:"none",cursor:"pointer"}}/></div>
                  {csvRows.length>0&&(<div style={{marginBottom:20}}><div style={{fontFamily:"'EB Garamond',serif",fontSize:13,color:C.muted,marginBottom:10}}>{csvRows.length} rows ready · AI will auto-tag after upload</div><button onClick={uploadCSV} disabled={csvUploading} className="f-save">{csvUploading?`Uploading…`:`Upload ${csvRows.length} Products →`}</button></div>)}
                  {csvStatus&&(<div style={{padding:16,background:csvStatus.errors.length===0?"#f0f8f0":"#fff8f0",border:`0.5px solid ${csvStatus.errors.length===0?C.green:C.amber}`}}><div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:csvStatus.errors.length===0?C.green:C.amber,marginBottom:6}}>{csvStatus.ok} product{csvStatus.ok!==1?"s":""} uploaded</div>{csvStatus.errors.map((e,i)=><div key={i} style={{fontSize:12,color:C.red}}>{e}</div>)}</div>)}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showPdfMeta&&(
        <div className="overlay" onClick={()=>setShowPdfMeta(false)}>
          <div className="overlay-box" onClick={e=>e.stopPropagation()}>
            <div className="overlay-title">Generate Catalogue</div>
            <div className="overlay-sub">{selectedProducts.length} products selected</div>
            <label className="o-label">Client / Company Name</label>
            <input className="o-inp" type="text" placeholder="e.g. Axis Bank" value={clientName} onChange={e=>setClientName(e.target.value)}/>
            <div className="o-btns">
              <button className="o-btn-s" onClick={()=>setShowPdfMeta(false)}>Cancel</button>
              <button className="o-btn-p" onClick={generatePDF} disabled={pdfLoading}>{pdfLoading?"Generating…":"Generate & Download →"}</button>
            </div>
          </div>
        </div>
      )}

      {tagProduct&&(
        <div className="tag-overlay" onClick={()=>setTagProduct(null)}>
          <div className="tag-panel" onClick={e=>e.stopPropagation()}>
            <div className="tag-panel-head">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div><div className="tag-panel-name">{tagProduct.name}</div><div className="tag-panel-meta">{tagProduct.category} · {tagProduct.tier} · ₹{parseFloat(tagProduct.price).toLocaleString("en-IN")}</div></div>
                <button onClick={()=>setTagProduct(null)} style={{background:"transparent",border:"none",color:"#888",fontSize:20,cursor:"pointer",lineHeight:1}}>×</button>
              </div>
            </div>
            <div className="tag-panel-body">
              {tagLoading?<div className="tag-loading">Analysing product with AI…</div>:(
                <>
                  <div style={{fontSize:13,color:C.muted,marginBottom:14,display:"flex",justifyContent:"space-between"}}><span>Review AI suggestions · tap to toggle · search to add</span><span style={{color:C.ink,fontWeight:500}}>{totalTagSelected} tags</span></div>
                  {DIMENSIONS.map(({key,label,required})=>{
                    const suggestions=tagSuggestions[key]||[];
                    const extra=(customTags[key]||[]).filter(t=>!suggestions.find(s=>s.tag===t));
                    const selSet=tagSelected[key]||new Set();
                    const extraSel=[...selSet].filter(t=>!suggestions.find(s=>s.tag===t)&&!extra.includes(t));
                    const search=tagSearches[key]||"";
                    const allLib=tagLibrary[key]||[];
                    const dropItems=search.length>0?allLib.filter(t=>t.includes(search.toLowerCase())&&!selSet.has(t)).slice(0,6):[];
                    const exactExists=allLib.includes(search.toLowerCase().replace(/\s+/g,"-"));
                    return (
                      <div className="tag-dim-card" key={key}>
                        <div className="tag-dim-head"><div className="tag-dim-label">{label}</div>{required&&<span className="tag-dim-req">required</span>}<span className="tag-dim-count">{selSet.size} selected</span></div>
                        <div className="tag-dim-body">
                          {suggestions.map(({tag,confidence})=>{const isSel=selSet.has(tag);return <span key={tag} className={`tag-chip${isSel?" sel":""}`} onClick={()=>toggleTag(key,tag)}>{tag}<span className={`tag-cf${isSel?"":" "+cfClass(confidence)}`}>{confidence}%</span></span>;})}
                          {extra.map(tag=><span key={tag} className={`tag-chip new-t${selSet.has(tag)?" sel":""}`} onClick={()=>toggleTag(key,tag)}>{tag}<span className="tag-new-badge">new</span></span>)}
                          {extraSel.map(tag=><span key={tag} className="tag-chip sel" onClick={()=>toggleTag(key,tag)}>{tag}</span>)}
                        </div>
                        <div className="tag-search-row" style={{position:"relative"}}>
                          <input className="tag-search-inp" placeholder="Search or add tag…" value={search} onChange={e=>setTagSearches(prev=>({...prev,[key]:e.target.value}))} onBlur={()=>setTimeout(()=>setTagSearches(prev=>({...prev,[key]:""})),180)}/>
                          {(dropItems.length>0||(search.length>1&&!exactExists))&&(<div className="tag-drop">{dropItems.map(t=><div key={t} className="tag-drop-item" onMouseDown={()=>{toggleTag(key,t);setTagSearches(prev=>({...prev,[key]:""}));}}>{t}</div>)}{search.length>1&&!exactExists&&<div className="tag-drop-create" onMouseDown={()=>addCustomTag(key,search)}>+ Create: <strong>{search.toLowerCase().replace(/\s+/g,"-")}</strong></div>}</div>)}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <div className="tag-panel-foot">
              <div style={{fontSize:13,color:C.muted}}>{newTagCount>0&&<span>{newTagCount} new tag{newTagCount>1?"s":""} added · </span>}{totalTagSelected} tags · {Object.values(tagSelected).filter(s=>s.size>0).length} dimensions</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>setTagProduct(null)} style={{padding:"10px 18px",border:`0.5px solid ${C.rule}`,background:"transparent",color:C.muted,fontSize:11,letterSpacing:2,textTransform:"uppercase",cursor:"pointer"}}>Cancel</button>
                <button onClick={saveTags} disabled={tagSaving} style={{padding:"10px 24px",background:"#0F6E56",border:"none",color:"#fff",fontSize:11,letterSpacing:2,textTransform:"uppercase",cursor:tagSaving?"not-allowed":"pointer",opacity:tagSaving?0.7:1}}>{tagSaving?"Saving…":"Confirm & save →"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
