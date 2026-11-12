const $ = (id) => document.getElementById(id);
let selectedFile = null;
let lastResult = null;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.error || "This action is temporarily unavailable.");
  return body;
}
function showApp() { $("loginScreen").classList.add("hidden"); $("app").classList.remove("hidden"); loadHistory(); }
async function checkLogin() {
  try { const s = await api("/api/status"); if (s.authenticated) showApp(); } catch {}
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("loginMessage").textContent = "Checking access…";
  try { await api("/api/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({code:$("accessCode").value}) }); $("loginMessage").textContent = ""; showApp(); }
  catch (err) { $("loginMessage").textContent = err.message; }
});
$("logoutBtn").addEventListener("click", async () => { try { await api("/api/logout", {method:"POST"}); } catch {} location.reload(); });

function chooseFile(file) {
  if (!file) return;
  if (!["image/jpeg","image/png","image/webp"].includes(file.type)) return alert("Please choose a JPG, PNG or WEBP image.");
  if (file.size > 6*1024*1024) return alert("This photo is larger than 6 MB. Choose a smaller image.");
  selectedFile = file; $("preview").src = URL.createObjectURL(file); $("fileName").textContent = file.name || "Camera photo";
  $("dropZone").classList.add("hidden"); $("previewWrap").classList.remove("hidden"); $("resultArea").classList.add("hidden");
}
$("fileInput").addEventListener("change", e => chooseFile(e.target.files[0]));
$("cameraInput").addEventListener("change", e => chooseFile(e.target.files[0]));
$("removePhoto").addEventListener("click", () => { selectedFile=null; $("fileInput").value=""; $("cameraInput").value=""; $("previewWrap").classList.add("hidden"); $("dropZone").classList.remove("hidden"); });
const dz=$("dropZone");
dz.addEventListener("dragover",e=>{e.preventDefault();dz.style.borderColor="#57977d";});
dz.addEventListener("dragleave",()=>dz.style.borderColor="");
dz.addEventListener("drop",e=>{e.preventDefault();dz.style.borderColor="";chooseFile(e.dataTransfer.files[0]);});

function safe(value) { return String(value ?? "Not available").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function asList(items) { return Array.isArray(items)&&items.length ? `<ul>${items.map(x=>`<li>${safe(x)}</li>`).join("")}</ul>` : "<p>Not available</p>"; }
function renderResult(r, saved=false) {
  lastResult=r;
  const details=[
    ["Purpose / uses",r.usesOrPurpose],["How it works / behaves",r.howItWorksOrBehaves],
    ["Characteristics",asList(r.characteristics)],["Habitat & food",r.habitatAndFood],
    ["Can it be purchased?",r.canBePurchased===true?"Yes, where legally sold.":r.canBePurchased===false?"No — it should not be bought or traded.": "Depends on the species or item."],
    ["Approximate price in India",r.approximatePriceIndia],["Where to find it",r.whereToFind],
    ["Care, safety & responsible use",r.careOrSafety],["Conservation",r.conservation],["Interesting facts",asList(r.funFacts)],["Similar things",asList(r.similarThings)]
  ];
  $("resultArea").innerHTML=`<article class="result-card"><div class="result-top"><div><p class="eyebrow">KNOWORA IDENTIFIED</p><h2>${safe(r.name)}</h2><span class="confidence">AI confidence estimate: ${safe(r.confidence)}% · ${saved?"Saved to your notebook":"Not saved"}</span></div><span class="category-tag">${safe(r.category)}</span></div><p class="result-desc">${safe(r.shortDescription)}</p><div class="detail-grid">${details.map(([h,v])=>`<section class="detail"><h4>${h}</h4>${typeof v==="string"&&v.startsWith("<")?v:`<p>${safe(v || "Not available")}</p>`}</section>`).join("")}</div>${r.uncertainty?`<p class="fine" style="margin-top:15px">Note: ${safe(r.uncertainty)}</p>`:""}<div class="result-actions"><button id="speakBtn" class="secondary">▶ Listen to explanation</button><button id="copyBtn" class="secondary">Copy summary</button></div></article>`;
  $("resultArea").classList.remove("hidden");
  $("speakBtn").addEventListener("click",()=>{if(!("speechSynthesis" in window))return alert("Voice reading is not supported in this browser.");const msg=new SpeechSynthesisUtterance(`${r.name}. ${r.shortDescription}. ${r.usesOrPurpose||""}`);msg.lang="en-IN";speechSynthesis.cancel();speechSynthesis.speak(msg);});
  $("copyBtn").addEventListener("click",async()=>{const text=`${r.name}\n${r.shortDescription}\nPurpose: ${r.usesOrPurpose||""}\nFacts: ${(r.funFacts||[]).join("; ")}`;try{await navigator.clipboard.writeText(text);$("copyBtn").textContent="Copied!";}catch{$("copyBtn").textContent="Copy unavailable";}});
}
$("identifyBtn").addEventListener("click", async()=>{
  if(!selectedFile)return;
  $("previewWrap").classList.add("hidden");$("progress").classList.remove("hidden");
  const form=new FormData();form.append("photo",selectedFile);
  try { const data=await api("/api/identify",{method:"POST",body:form}); renderResult(data.result,data.saved); }
  catch(err){$("resultArea").innerHTML=`<article class="result-card"><p class="eyebrow">A SMALL PAUSE</p><h2>We couldn't identify this photo just now.</h2><p class="muted">${safe(err.message)}</p><p class="fine">Your photo is not kept by Knowora. You can use Search or try again later.</p></article>`;$("resultArea").classList.remove("hidden");}
  finally{$("progress").classList.add("hidden");$("previewWrap").classList.remove("hidden");}
});
$("searchForm").addEventListener("submit",async e=>{
  e.preventDefault();const q=$("searchInput").value.trim();if(!q)return;
  $("searchResults").textContent="Searching your saved discoveries…";
  try{const data=await api(`/api/search?q=${encodeURIComponent(q)}`);$("searchResults").innerHTML=data.results.length?data.results.map(x=>`<div class="search-result"><b>${safe(x.item_name)}</b> · ${safe(x.category)}<br><span class="fine">Confidence ${safe(x.confidence)}%</span></div>`).join(""):`<span class="fine">${safe(data.note||"No saved matches yet. Identify a photo to add a discovery.")}</span>`;}
  catch(err){$("searchResults").textContent=err.message;}
});
async function loadHistory(){
  try{const data=await api("/api/history");$("historyList").innerHTML=data.items.length?data.items.map(x=>`<div class="history-item"><b>${safe(x.item_name)}</b><small>${safe(x.category)} · ${new Date(x.created_at).toLocaleDateString()}</small></div>`).join(""):`<p class="muted">${data.configured?"No discoveries saved yet.":"Connect Supabase to save your discovery history."}</p>`;}
  catch{$("historyList").innerHTML='<p class="muted">Your notebook will be available when the service reconnects.</p>';}
}
$("refreshHistory").addEventListener("click",loadHistory);
checkLogin();