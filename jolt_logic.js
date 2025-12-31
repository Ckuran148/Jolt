// --- SECURE CONFIGURATION ---
const ENDPOINT = "https://jolt-proxy.ckuran.workers.dev";
const HEADERS = { "Content-Type": "application/json" };

// Global State
let currentListsCache = []; 
let locationsCache = [];
let gridDataCache = [];
let reportDataCache = []; 
let safetyGridDataCache = []; // New Cache for Safety Grid
let storeMetadataCache = [];

// --- 1. HELPER FUNCTIONS ---

const logBox = document.getElementById('system-log');
function log(msg, type='info') {
    if(!logBox) return;
    console.log(`[${type}] ${msg}`);
}

function formatDateMMDDYYYY(timestampOrDate) {
    if(!timestampOrDate) return "";
    let d;
    if (typeof timestampOrDate === 'number') {
        // Handle Jolt's mixed ms vs sec timestamps
        if (timestampOrDate > 946684800000) d = new Date(timestampOrDate); 
        else d = new Date(timestampOrDate * 1000);
    } else {
        d = new Date(timestampOrDate);
    }
    if (isNaN(d.getTime())) return "";

    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
}
// HELPER: Wait for X milliseconds
const delay = ms => new Promise(res => setTimeout(res, ms));
// FORMAT TIME (Fixes Timezone Issues by using local string)
function formatTime(timestamp) {
    if (!timestamp) return "";
    let d = timestamp > 946684800000 ? new Date(timestamp) : new Date(timestamp * 1000);
    return d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}
// Helper to safely get metadata (Paste this anywhere in the global scope)
function getMetaForLoc(loc) {
    if (!storeMetadataCache) return null;
    const locName = loc.name.toLowerCase();
    return storeMetadataCache.find(m => {
        if (m.site && m.site.length > 2 && locName.includes(m.site)) return true;
        if (m.store && locName.includes(m.store.toLowerCase())) return true;
        return false;
    });
}
function calculateDuration(items) {
    if (!items || !Array.isArray(items)) return { text: null, seconds: null };
    let timestamps = [];
    const collectTimestamps = (itemList) => {
        itemList.forEach(i => {
            if (i.completionTimestamp > 0) timestamps.push(i.completionTimestamp);
            if (i.subList && i.subList.itemResults) collectTimestamps(i.subList.itemResults);
        });
    };
    collectTimestamps(items);

    if (timestamps.length >= 2) {
        timestamps.sort((a, b) => a - b);
        const diffSeconds = timestamps[timestamps.length - 1] - timestamps[0];
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        return { text: `${hours}h ${minutes}m`, seconds: diffSeconds };
    } else if (timestamps.length === 1) {
            return { text: "< 1m", seconds: 0 };
    }
    return { text: null, seconds: null };
}

function checkExpirationStatus(items) {
    let status = { expired: false, expiring: false, warning: false };
    if (!items || !Array.isArray(items)) return status;
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const sevenDays = new Date();
    sevenDays.setDate(today.getDate() + 7);
    sevenDays.setHours(0,0,0,0);

    const scan = (list) => {
        list.forEach(i => {
            const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : "";
            const isExpItem = prompt.includes("Sanitizer") && prompt.includes("Exp. Date");

            if (isExpItem && i.resultDouble) {
                const expDate = new Date(i.resultDouble * 1000);
                expDate.setHours(0,0,0,0); 

                if (expDate < today) status.expired = true;
                else if (expDate.getTime() === today.getTime()) status.expiring = true;
                else if (expDate <= sevenDays) status.warning = true;
            }
            if (i.subList && i.subList.itemResults) scan(i.subList.itemResults);
        });
    };
    scan(items);
    return status;
}

function getAuditScore(items) {
    let earned = 0;
    let possible = 0;
    const traverse = (nodes) => {
        nodes.forEach(node => {
            const type = (node.itemTemplate && node.itemTemplate.type) ? node.itemTemplate.type : "";
            // Score if it's not just text and not marked N/A
            if (type !== 'TEXT') {
                 if (!node.isMarkedNA) {
                     possible++;
                     // Jolt considers it "earned" if it has a completion timestamp (is done)
                     if (node.completionTimestamp > 0) earned++;
                 }
            }
            if (node.subList && node.subList.itemResults) traverse(node.subList.itemResults);
        });
    }
    traverse(items);
    return { earned, possible, pct: possible > 0 ? Math.round((earned/possible)*100) : 0 };
}

function extractReportStats(items) {
    let stats = { coldMin: null, coldMax: null, coldCount: 0, hotMin: null, hotMax: null, hotCount: 0, naCount: 0 };
    if(!items) return stats;
    const flatten = (list) => {
        list.forEach(i => {
            if (i.isMarkedNA) stats.naCount++;
            if (i.resultDouble) {
                const val = i.resultDouble;
                if (val < 50) {
                    if (stats.coldMin === null || val < stats.coldMin) stats.coldMin = val;
                    if (stats.coldMax === null || val > stats.coldMax) stats.coldMax = val;
                    stats.coldCount++;
                } else if (val > 130) {
                    if (stats.hotMin === null || val < stats.hotMin) stats.hotMin = val;
                    if (stats.hotMax === null || val > stats.hotMax) stats.hotMax = val;
                    stats.hotCount++;
                }
            }
            if (i.subList && i.subList.itemResults) flatten(i.subList.itemResults);
        });
    };
    flatten(items);
    return stats;
}

function calculateIntegrity(items, listName = "", durationSeconds = null) {
    if (!items || !Array.isArray(items)) return { score: null, issues: [] };
    
    // Skip scoring for Temperature logs or Critical Focus lists if desired
    const lowerName = listName ? listName.toLowerCase() : "";
    if (lowerName.includes("equipment temperature") || lowerName.includes("fsa - critical") || lowerName.includes("critical daily focus")) {
        return { score: null, issues: [] };
    }

    const isDaypart1 = lowerName.includes("daypart 1");
    const isRelaxedList = isDaypart1 || lowerName.includes("breakfast");

    let score = 100;
    let issues = [];
    let completedItems = [];
    let tempValues = [];
    let naCount = 0;
    let totalCount = 0;
    let integerTempCount = 0;

    const flattenItems = (list) => {
        list.forEach(i => {
            const typeUpper = (i.type || "").toUpperCase();
            const templateTypeUpper = ((i.itemTemplate && i.itemTemplate.type) || "").toUpperCase();
            
            if (typeUpper !== 'TEXT' && templateTypeUpper !== 'TEXT') {
                totalCount++;
                if (i.isMarkedNA) naCount++;
                
                if (i.completionTimestamp > 0) {
                    const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text.toLowerCase() : "";
                    const isEquipmentTemp = prompt.includes('equipment') || prompt.includes('cooler') || prompt.includes('freezer') || prompt.includes('walk-in') || prompt.includes('reach-in') || prompt.includes('refrigerator') || prompt.includes('fryer') || prompt.includes('warmer');

                    if (!isEquipmentTemp) completedItems.push(i);
                    
                    const hasTempKey = prompt.includes('temp') || prompt.includes('°') || prompt.includes('℉') || prompt.includes('℃') || prompt.includes(' f ') || prompt.includes(' c ');
                    
                    if (!isEquipmentTemp && i.resultDouble !== null && i.resultDouble !== undefined && (hasTempKey || i.resultDouble > 0)) {
                        tempValues.push({ val: i.resultDouble, time: i.completionTimestamp });
                        const isCount = prompt.includes('count') || prompt.includes('number') || prompt.includes('amount') || prompt.includes('quantity');
                        if (!isCount && i.resultDouble % 1 === 0) integerTempCount++;
                    }
                }
                if (i.subList && i.subList.itemResults) flattenItems(i.subList.itemResults);
            }
        });
    };
    flattenItems(items);

    // Sublist Speed Checks
    const checkSublists = (currentItems) => {
        currentItems.forEach(item => {
            if (item.subList && item.subList.itemResults) {
                const parentText = (item.itemTemplate && item.itemTemplate.text) ? item.itemTemplate.text : "";
                const subName = item.subList.instanceTitle || parentText || "";
                const subItems = item.subList.itemResults;
                
                let subTimestamps = [];
                const getTimes = (nodes) => {
                    nodes.forEach(n => {
                        if(n.completionTimestamp > 0) subTimestamps.push(n.completionTimestamp);
                        if(n.subList && n.subList.itemResults) getTimes(n.subList.itemResults);
                    });
                };
                getTimes(subItems);
                
                if (subTimestamps.length >= 2) {
                    subTimestamps.sort((a,b) => a-b);
                    const subDur = subTimestamps[subTimestamps.length-1] - subTimestamps[0];
                    const lower = subName.toLowerCase();
                    const lowerParent = parentText.toLowerCase();
                    const isCritical = lower.includes('beef') || lower.includes('frosty') || lower.includes('chili') || lower.includes('chicken') || lowerParent.includes('beef') || lowerParent.includes('frosty') || lowerParent.includes('chili') || lowerParent.includes('chicken');
                    const frostyCheck = (lower.includes('frosty') || lowerParent.includes('frosty')) && subDur < 15;
                    const otherCriticalCheck = !lower.includes('frosty') && !lowerParent.includes('frosty') && isCritical && subDur < 25;

                    if (frostyCheck || otherCriticalCheck) {
                        score -= 40; 
                        issues.push(`Sublist '${subName}' too fast (${subDur}s)`);
                    }
                }
                const subScoreData = calculateIntegrity(subItems, subName);
                if (subScoreData.score !== null && subScoreData.score < 60) {
                    score -= 40;
                    issues.push(`Sublist '${subName}' Failed Integrity`);
                }
                checkSublists(subItems);
            }
        });
    };
    checkSublists(items);

    const timeThreshold = isDaypart1 ? 180 : 300;
    const timeLabel = isDaypart1 ? "3 mins" : "5 mins";

    if (durationSeconds !== null && durationSeconds < timeThreshold && completedItems.length > 10) {
            score -= 20;
            issues.push(`Full List < ${timeLabel}`);
    }

    if (completedItems.length < 2 && score === 100) return { score: Math.max(0, score), issues };

    if (completedItems.length > 1) {
        completedItems.sort((a, b) => a.completionTimestamp - b.completionTimestamp);
        let rapidCount = 0;
        const intervals = Math.max(1, completedItems.length - 1); 
        for (let i = 1; i < completedItems.length; i++) {
            if ((completedItems[i].completionTimestamp - completedItems[i-1].completionTimestamp) < 2) rapidCount++; 
        }
        const rapidPercent = (rapidCount / intervals) * 100;
        if (rapidPercent > 75) { score -= 30; issues.push("Speed Detection (Too Fast)"); } 
        else if (rapidPercent > 45) { score -= 10; issues.push("Potential Rapid Entry"); }
    }

    if (tempValues.length >= 2) {
        if ((integerTempCount / tempValues.length) > 0.6) {
            score -= 30;
            issues.push("Manual Entry Suspected (No Decimals)");
        }
        const values = tempValues.map(t => t.val);
        const uniqueValues = new Set(values);
        const duplicateRate = 1 - (uniqueValues.size / values.length);
        const dupThreshold = isRelaxedList ? 0.65 : 0.3; 
        if (duplicateRate > dupThreshold) { score -= 40; issues.push(`High Duplicate Temps (${Math.round(duplicateRate*100)}%)`); }
        if (values.length > 1 && uniqueValues.size === 1) { score -= 60; issues.push("Identical Temperatures"); }

        tempValues.sort((a, b) => a.time - b.time);
        let suspiciousPairs = 0;
        let totalPairs = Math.max(1, tempValues.length - 1);
        for(let i=1; i<tempValues.length; i++) {
            const timeDiff = tempValues[i].time - tempValues[i-1].time;
            const valDiff = Math.abs(tempValues[i].val - tempValues[i-1].val);
            const valThreshold = isRelaxedList ? 0.1 : 0.5;
            if (timeDiff < 45 && valDiff < valThreshold) suspiciousPairs++;
        }
        const suspiciousRate = suspiciousPairs / totalPairs;
        if (suspiciousRate > 0.5) { score -= 50; issues.push("Rapid Similar/Same Temps"); }
        else if (suspiciousPairs > 0 && tempValues.length < 5) { score -= 30; issues.push("Rapid Similar/Same Temps"); }
    }
    if (totalCount > 0) {
        const naPercent = (naCount / totalCount) * 100;
        if (naPercent > 50) { score -= 50; issues.push(`Excessive N/A`); } 
        else if (naPercent > 30) { score -= 25; issues.push("High N/A Usage"); } 
    }
    return { score: Math.max(0, score), issues };
}

// --- 2. CONFIGURATION & CORE LOGIC ---
let config = { proxyUrl: ENDPOINT };

window.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    // Get LOCAL date parts (not UTC)
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    
    const todayStr = `${yyyy}-${mm}-${dd}`;   // For Date Inputs (YYYY-MM-DD)
    const monthStr = `${yyyy}-${mm}`;         // For Month Inputs (YYYY-MM)
    
    // Set default dates for daily inputs
    // 'gridDate' is the DFSL Filter Date
    const els = ['startDate', 'endDate', 'gridDate', 'reportDate'];
    els.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.value = todayStr;
    });

    // Set default month for Audits
    const auditMonth = document.getElementById('auditMonth');
    if(auditMonth) auditMonth.value = monthStr;

    // Set default month for Safety Grid
    const safetyMonth = document.getElementById('safetyMonth');
    if(safetyMonth) safetyMonth.value = monthStr;
    
    // Auto-Close Filters on Mobile
    if (window.innerWidth < 768) {
        document.querySelectorAll('details.filter-toggle').forEach(el => {
            el.removeAttribute('open');
        });
    }

    loadConfigUI();
    fetchLocations();
    loadStoreMetadata();

    // RESTORE TAB FROM HASH
    const hash = window.location.hash.replace('#', '');
    if(hash) {
        switchTab(hash);
    } else {
        switchTab('inspector');
    }
});

// --- METADATA (CSV) LOADER ---
async function loadStoreMetadata() {
    try {
        const resp = await fetch('Emails DM Sites CSV.csv');
        if(!resp.ok) throw new Error("CSV Not Found");
        const csvText = await resp.text();
        parseStoreMetadata(csvText);
        populateGridFilters();
    } catch(e) {
        console.error("Error loading metadata (CSV required):", e);
        // NO FALLBACK DATA provided, per request. Filters will remain empty if CSV fails.
    }
}

function parseStoreMetadata(csvText) {
    storeMetadataCache = [];
    const lines = csvText.split('\n');
    if(lines.length === 0) return;

    // Smart Header Parsing
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]+/g, ''));
    
    const iSite = headers.indexOf('site');
    const iStore = headers.indexOf('store');
    const iMarket = headers.indexOf('market');
    const iDistrict = headers.indexOf('district');

    if(iStore === -1 || iMarket === -1) {
        console.error("CSV Missing required columns (Store, Market)");
        return;
    }

    for(let i=1; i<lines.length; i++) {
        if(!lines[i].trim()) continue;
        const row = lines[i].split(',').map(cell => cell.trim().replace(/['"]+/g, ''));
        
        if(row.length < 2) continue; // Skip malformed rows
        
        storeMetadataCache.push({
            site: (iSite > -1) ? row[iSite] : null,
            store: row[iStore],
            market: (iMarket > -1) ? row[iMarket] : 'Unknown',
            district: (iDistrict > -1) ? row[iDistrict] : 'Unknown'
        });
    }
}
// --- OPS GRID HIERARCHY LOGIC ---
// --- OPS GRID HIERARCHY LOGIC ---
// --- OPS GRID HIERARCHY LOGIC (Robust) ---
function updateOpsGridHierarchy(source) {
    const marketSel = document.getElementById('marketFilter');
    const districtSel = document.getElementById('districtFilter');
    const locationSel = document.getElementById('locationSelect');

    if (!marketSel || !districtSel || !locationSel) return;

    // 1. Get Current Selections (Cleaned)
    const selectedMarket = marketSel.value.trim();
    const selectedDistrict = districtSel.value.trim();

    // 2. Filter Available Locations
    let availableLocs = locationsCache;

    // Filter by Market
    if (selectedMarket) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.market.trim() === selectedMarket;
        });
    }

    // Filter by District (only if source is 'district' or we are refreshing lists)
    if (source === 'district' && selectedDistrict) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.district.trim() === selectedDistrict;
        });
    }

    // 3. Update District Dropdown (If Market Changed or Init)
    if (source === 'market' || source === 'init') {
        const uniqueDistricts = new Set();
        availableLocs.forEach(loc => {
            const meta = getMetaForLoc(loc);
            if (meta && meta.district) uniqueDistricts.add(meta.district.trim());
        });
        
        // Save old selection to prevent annoying resets if possible
        const oldDist = districtSel.value;

        districtSel.innerHTML = '<option value="">All Districts</option>';
        Array.from(uniqueDistricts).sort().forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; 
            opt.textContent = d; 
            districtSel.appendChild(opt);
        });

        // Restore selection if it still exists in the new list
        if (source === 'init' && oldDist && uniqueDistricts.has(oldDist)) {
             districtSel.value = oldDist;
        } else {
            districtSel.value = "";
        }
    }

    // 4. Update Location Dropdown (Always)
    locationSel.innerHTML = '<option value="">All Locations</option>';
    availableLocs.sort((a,b) => a.name.localeCompare(b.name));
    
    availableLocs.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.name;
        locationSel.appendChild(opt);
    });
}
// --- DFSL GRID FILTER LOGIC (New Unique Function) ---
function updateGridFilters(source) {
    const marketSel = document.getElementById('gridMarketFilter');
    const districtSel = document.getElementById('gridDistrictFilter');
    const locationSel = document.getElementById('gridLocationFilter');

    if (!marketSel || !districtSel || !locationSel) return;

    const selectedMarket = marketSel.value.trim();
    const selectedDistrict = districtSel.value.trim();

    let availableLocs = locationsCache;

    // Filter by Market
    if (selectedMarket) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.market.trim() === selectedMarket;
        });
    }

    // Filter by District
    if (source === 'district' && selectedDistrict) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.district.trim() === selectedDistrict;
        });
    }

    // Update District Dropdown
    if (source === 'market' || source === 'init') {
        const uniqueDistricts = new Set();
        availableLocs.forEach(loc => {
            const meta = getMetaForLoc(loc);
            if (meta && meta.district) uniqueDistricts.add(meta.district.trim());
        });
        
        const oldDist = districtSel.value;
        districtSel.innerHTML = '<option value="">All Districts</option>';
        Array.from(uniqueDistricts).sort().forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; opt.textContent = d; districtSel.appendChild(opt);
        });
        
        if (source === 'init' && oldDist && uniqueDistricts.has(oldDist)) {
             districtSel.value = oldDist;
        } else {
            districtSel.value = "";
        }
    }

    // Update Location Dropdown
    locationSel.innerHTML = '<option value="">All Locations</option>';
    availableLocs.sort((a,b) => a.name.localeCompare(b.name));
    
    availableLocs.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id; opt.textContent = loc.name; locationSel.appendChild(opt);
    });
}
// Helper to safely get metadata
function getMetaForLoc(loc) {
    if (!storeMetadataCache) return null;
    const locName = loc.name.toLowerCase();
    return storeMetadataCache.find(m => {
        if (m.site && m.site.length > 2 && locName.includes(m.site)) return true;
        if (m.store && locName.includes(m.store.toLowerCase())) return true;
        return false;
    });
}
function populateGridFilters() {
    // 1. Define Filters
    const marketSelects = [
        document.getElementById('marketFilter'),      // Inspector
        document.getElementById('gridMarketFilter'),  // DFSL Grid (New)
        document.getElementById('safetyMarketFilter'), // Safety
        document.getElementById('probeMarketFilter_v2') // Probe
    ];
    const districtSelects = [
        document.getElementById('districtFilter'), 
        document.getElementById('safetyDistrictFilter'),
        document.getElementById('probeDistrictFilter_v2')
    ];

    let availableMarkets = new Set();
    let availableDistricts = new Set();

    // 2. Build Lists from Cache
    if (locationsCache.length > 0 && storeMetadataCache.length > 0) {
        locationsCache.forEach(loc => {
            const meta = getMetaForLoc(loc);
            if(meta) {
                if(meta.market) availableMarkets.add(meta.market.trim());
                if(meta.district) availableDistricts.add(meta.district.trim());
            }
        });
    }

    const sortedMarkets = Array.from(availableMarkets).sort();
    const sortedDistricts = Array.from(availableDistricts).sort();

    // 3. Helper to Fill Dropdowns
    const fillDropdown = (selectElements, items, defaultLabel) => {
        selectElements.forEach(sel => {
            if(!sel) return; 
            const currentVal = sel.value;
            sel.innerHTML = `<option value="">${defaultLabel}</option>`;
            items.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item; opt.textContent = item; sel.appendChild(opt);
            });
            if (currentVal && items.includes(currentVal)) sel.value = currentVal;
        });
    };

    fillDropdown(marketSelects, sortedMarkets, "All Markets");
    fillDropdown(districtSelects, sortedDistricts, "All Districts");

    // 4. NEW: Fill the Safety Location Dropdown
    const safetyLocSel = document.getElementById('safetyLocationFilter');
    if (safetyLocSel && locationsCache.length > 0) {
        const currentLoc = safetyLocSel.value;
        safetyLocSel.innerHTML = '<option value="">All Locations</option>';
        locationsCache.sort((a,b) => a.name.localeCompare(b.name)).forEach(loc => {
            const opt = document.createElement('option');
            opt.value = loc.id; opt.textContent = loc.name; safetyLocSel.appendChild(opt);
        });
        if(currentLoc) safetyLocSel.value = currentLoc;
    }

    // 5. Initialize Main Grid Hierarchy (with safety check)
    if (typeof updateOpsGridHierarchy === 'function') {
        const mainMarket = document.getElementById('marketFilter');
        if (mainMarket) updateOpsGridHierarchy('init');
    }
// TRIGGER UPDATES FOR ALL GRIDS
    if (typeof updateOpsGridHierarchy === 'function') updateOpsGridHierarchy('init');
    if (typeof updateGridFilters === 'function') updateGridFilters('init'); // <-- ADD THIS
    if (typeof updateSafetyFilters === 'function') updateSafetyFilters('init');
}
// 6. Initialize Safety Grid Hierarchy
    if (typeof updateSafetyFilters === 'function') {
        updateSafetyFilters('init');
    }

// --- Tab Switching (With Hash Persistence) ---
function switchTab(tabName) {
    try {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.view-content').forEach(view => view.classList.remove('active'));
        
        const btnId = `nav-${tabName}`;
        const activeBtn = document.getElementById(btnId);
        if(activeBtn) activeBtn.classList.add('active');

        const viewId = `tab-${tabName}`;
        const activeView = document.getElementById(viewId);
        if(activeView) activeView.classList.add('active');
        // Inside switchTab(tabName)...
if (tabName === 'admin') {
    loadAdminPanel();
}
        // Update URL Hash
        window.location.hash = tabName;

        // Reset Mobile States
        document.querySelectorAll('.list-sidebar').forEach(el => el.classList.remove('mobile-hidden'));
        document.querySelectorAll('.detail-panel').forEach(el => el.classList.remove('mobile-active'));

    } catch(e) {
        console.error("Tab switch error:", e);
    }
}

// --- MOBILE VIEW LOGIC ---
function backToMobileList(sidebarId, detailId) {
    const sidebar = document.getElementById(sidebarId);
    const detail = document.getElementById(detailId);
    if(sidebar) sidebar.classList.remove('mobile-hidden');
    if(detail) detail.classList.remove('mobile-active');
}

function showMobileDetail(sidebarId, detailId) {
    if(window.innerWidth > 768) return;
    const sidebar = document.getElementById(sidebarId);
    const detail = document.getElementById(detailId);
    if(sidebar) sidebar.classList.add('mobile-hidden');
    if(detail) detail.classList.add('mobile-active');
}

async function fetchLocations() {
    // 1. Get Dropdown Elements
    const select = document.getElementById('locationSelect');
    const reportSelect = document.getElementById('reportLocationSelect');
    const auditSelect = document.getElementById('auditLocationSelect');
    
    try {
        console.log("--- START FETCH LOCATIONS ---");
        console.log("User Role:", userProfile.role);
        console.log("User Scope (Raw):", userProfile.scope);

        // 2. Fetch ALL locations from Jolt API
        const query = `query GetLocations { company { locations { id name } } }`;
        const data = await joltFetch(query);
        let rawLocations = data.data?.company?.locations || [];
        
        console.log(`Jolt returned ${rawLocations.length} total locations.`);

        // 3. Filter Locations based on Permissions
        locationsCache = rawLocations.filter(loc => {
            // ADMIN: Access All
            if (!userProfile.role || userProfile.role === 'admin') return true;

            const locName = loc.name.toLowerCase().trim();
            
            // Prepare Scope List: "Store A, Store B" -> ["store a", "store b"]
            const rawScope = userProfile.scope || "";
            const userScopes = rawScope.split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);

            // --- RULE 1: STORE ROLE (The Fix) ---
            if (userProfile.role === 'store') {
                // Check if ANY of the user's scope strings appear inside the location name
                // Example: User has "Post Falls". Location is "001 - Post Falls".
                // "001 - post falls".includes("post falls") === TRUE.
                const isMatch = userScopes.some(scopeItem => locName.includes(scopeItem));
                
                if (isMatch) console.log(`✅ Access Granted: [${loc.name}] matched scope criteria.`);
                return isMatch;
            }

            // --- RULE 2: MARKET / DISTRICT ROLE ---
            // We need metadata to link a Location to a Market/District
            const meta = storeMetadataCache.find(m => {
                if (m.site && m.site.length > 2 && locName.includes(m.site)) return true;
                if (m.store && locName.includes(m.store.toLowerCase())) return true;
                return false;
            });

            if (!meta) {
                // console.log(`❌ No Metadata for: ${loc.name}`);
                return false; 
            }

            // Check against Market/District List
            if (userProfile.role === 'market') {
                return userScopes.includes(meta.market.toLowerCase().trim());
            }
            if (userProfile.role === 'district') {
                return userScopes.includes(meta.district.toLowerCase().trim());
            }

            return false;
        });

        console.log(`Final Access Count: ${locationsCache.length} locations.`);

        // 4. Sort & Populate Dropdowns
        locationsCache.sort((a, b) => a.name.localeCompare(b.name));
        
        [select, reportSelect, auditSelect].forEach(sel => {
            if(!sel) return;
            sel.innerHTML = '';
            if (locationsCache.length === 0) { 
                sel.innerHTML = '<option>No Access / No Locations</option>'; 
            } else {
                locationsCache.forEach(loc => {
                    const opt = document.createElement('option');
                    opt.value = loc.id; 
                    opt.textContent = loc.name; 
                    sel.appendChild(opt);
                });
            }
        });

        // 5. Update Grid Filters (Ops, Safety, Probe)
        populateGridFilters();

    } catch (err) { 
        handleError(err, "fetching locations"); 
    }
}

// 2. Fetch Checklists (Inspector)
async function fetchChecklists() {
    const locationId = document.getElementById('locationSelect').value;
    const startDateStr = document.getElementById('startDate').value;
    const endDateStr = document.getElementById('endDate').value;
    const sidebar = document.getElementById('listSidebar');

    if(!locationId || !startDateStr || !endDateStr) { alert("Please select location and dates."); return; }
    sidebar.innerHTML = '<div style="padding:20px;">Loading checklists...</div>';
    
    // Fix Timezone: Construct dates as specific strings to avoid UTC shifting
    const startTimestamp = Math.floor(new Date(startDateStr + 'T00:00:00').getTime() / 1000);
    const endTimestamp = Math.floor(new Date(endDateStr + 'T23:59:59').getTime() / 1000);
    
    const lists = await fetchListsForLocation(locationId, startTimestamp, endTimestamp);
    
    lists.sort((a, b) => {
        const nameA = (a.listTemplate && a.listTemplate.title) ? a.listTemplate.title : (a.instanceTitle || "");
        const nameB = (b.listTemplate && b.listTemplate.title) ? b.listTemplate.title : (b.instanceTitle || "");
        // Safety lists first
        const isSafetyA = /FSL|DFSL|🟧|Food Safety/i.test(nameA);
        const isSafetyB = /FSL|DFSL|🟧|Food Safety/i.test(nameB);
        if (isSafetyA && !isSafetyB) return -1;
        if (!isSafetyA && isSafetyB) return 1;
        return (b.displayTimestamp || 0) - (a.displayTimestamp || 0);
    });

    currentListsCache = lists; 
    sidebar.innerHTML = '';
    if (lists.length === 0) { sidebar.innerHTML = '<div style="padding:20px;">No lists found.</div>'; return; }

    const now = Math.floor(Date.now() / 1000);

    lists.forEach(list => {
        const item = document.createElement('div');
        item.className = 'list-item';
        
        let statusBadge = '';
        let incomplete = list.incompleteCount || 0;
        if (incomplete === 0) statusBadge = '<span class="list-status ls-complete">Complete</span>';
        else if (list.deadlineTimestamp > 0 && list.deadlineTimestamp < now) statusBadge = '<span class="list-status ls-late">Late</span>';
        else if (list.displayTimestamp > now) statusBadge = '<span class="list-status ls-upcoming">Upcoming</span>';
        else statusBadge = '<span class="list-status ls-progress">In Progress</span>';

        const listName = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled List");
        const listDate = list.displayTimestamp ? new Date(list.displayTimestamp * 1000) : null;
        const dateStr = listDate ? `${formatDateMMDDYYYY(listDate)} ${formatTime(listDate)}` : "";

        let durationTxt = "N/A";
        let integrityBadge = "";
        let scoreVal = "N/A";
        let expiryIndicator = "";

        if (list.itemResults) {
            const dur = calculateDuration(list.itemResults);
            if (dur.text) durationTxt = dur.text;

            const targetLists = ['🟧', 'DFSL', 'FSL', 'Food Safety'];
            const isTargetList = targetLists.some(tag => listName.includes(tag));
            
            if (isTargetList && incomplete === 0) {
                const scoreData = calculateIntegrity(list.itemResults, listName, dur.seconds);
                scoreVal = scoreData.score + "%";
                let badgeClass = 'integrity-high';
                if (scoreData.score === null) { badgeClass = 'integrity-na'; scoreVal = "N/A"; }
                else if (scoreData.score < 60) badgeClass = 'integrity-low';
                else if (scoreData.score < 85) badgeClass = 'integrity-med';
                integrityBadge = `<span class="integrity-badge ${badgeClass}">${scoreVal}</span>`;
            }
            const expStatus = checkExpirationStatus(list.itemResults);
            if (expStatus.expired) expiryIndicator = "🔴";
            else if (expStatus.expiring) expiryIndicator = "🟡";
            else if (expStatus.warning) expiryIndicator = "🟠";
        }
        
        list._computed = {
            status: statusBadge.replace(/<[^>]*>?/gm, ''),
            duration: durationTxt,
            integrity: scoreVal,
            locationName: document.getElementById('locationSelect').options[document.getElementById('locationSelect').selectedIndex].text
        };

        item.innerHTML = `
            <span class="list-title">${listName} ${expiryIndicator}</span>
            <div class="list-meta">
                <span>${dateStr}</span>
                ${statusBadge}
            </div>
            <div class="list-stats">
                <span>⏱️ ${durationTxt}</span>
                ${integrityBadge ? `<span>🛡️ ${integrityBadge}</span>` : ''}
            </div>
        `;
        item.onclick = () => {
            document.querySelectorAll('.list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            renderListDetails(list, 'detailView');
            showMobileDetail('listSidebar', 'detailView');
        };
        sidebar.appendChild(item);
    });
}

// 3. Fetch Audits
async function fetchAudits() {
    const locId = document.getElementById('auditLocationSelect').value;
    const monthStr = document.getElementById('auditMonth').value;
    const sidebar = document.getElementById('auditSidebar');
    if(!locId || !monthStr) { alert("Please select a location and month."); return; }
    
    sidebar.innerHTML = '<div style="padding:20px;">Loading audits...</div>';
    
    const [yyyy, mm] = monthStr.split('-');
    const startDate = new Date(parseInt(yyyy), parseInt(mm)-1, 1);
    const endDate = new Date(parseInt(yyyy), parseInt(mm), 0);
    const startTs = Math.floor(startDate.getTime() / 1000);
    const endTs = Math.floor(endDate.setHours(23,59,59) / 1000);
    
    const lists = await fetchListsForLocation(locId, startTs, endTs);
    // Filter for audits AND agendas
    const auditLists = lists.filter(l => {
        const title = (l.listTemplate && l.listTemplate.title) ? l.listTemplate.title : (l.instanceTitle || "");
        const tLower = title.toLowerCase();
        return tLower.includes("monthly safety audit") || tLower.includes("safety committee agenda");
    });
    
    sidebar.innerHTML = '';
    if(auditLists.length === 0) { sidebar.innerHTML = '<div style="padding:20px;">No audits found for this month.</div>'; return; }
    
    auditLists.sort((a,b) => (b.displayTimestamp || 0) - (a.displayTimestamp || 0));
    
    auditLists.forEach(list => {
        const item = document.createElement('div');
        item.className = 'list-item';
        const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled");
        const listDate = list.displayTimestamp ? new Date(list.displayTimestamp * 1000) : null;
        const dateStr = listDate ? formatDateMMDDYYYY(listDate) : "";
        let status = "In Progress"; let statusClass = "ls-progress";
        if(list.incompleteCount === 0) { status = "Complete"; statusClass = "ls-complete"; }

        let scoreHtml = "";
        const titleLower = title.toLowerCase();
        if(!titleLower.includes("agenda") && list.score !== undefined && list.score !== null) {
             let max = list.maxPossibleScore;
             if (!max) {
                 const calculatedStats = getAuditScore(list.itemResults || []);
                 max = calculatedStats.possible;
             }
             const pct = max > 0 ? Math.round((list.score / max) * 100) : 0;
             scoreHtml = `<div style="font-size:0.8rem; margin-top:4px; color:#555;"><strong>Score:</strong> ${pct}% (${list.score}/${max})</div>`;
        }
        item.innerHTML = `
            <span class="list-title">${title}</span>
            <div class="list-meta">
                <span>${dateStr}</span>
                <span class="list-status ${statusClass}">${status}</span>
            </div>
            ${scoreHtml}
        `;
        item.onclick = () => {
            document.querySelectorAll('.list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            renderListDetails(list, 'auditDetailView');
            showMobileDetail('auditSidebar', 'auditDetailView');
        };
        sidebar.appendChild(item);
    });
}

// --- OPS GRID VIEW LOGIC ---
// --- OPS GRID VIEW LOGIC ---
// --- UPDATED OPS GRID LOADER ---
async function loadStoreGrid() {
    const dateStr = document.getElementById('gridDate').value;

    const selMarket = document.getElementById('gridMarketFilter').value.trim();
    const selDistrict = document.getElementById('gridDistrictFilter').value.trim();
    const selLocationId = document.getElementById('gridLocationFilter').value;

    if (!dateStr) { alert("Please select date."); return; }
    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    overlay.style.display = 'flex';
    gridDataCache = []; reportDataCache = [];

    const startTs = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 1000);
    const endTs = Math.floor(new Date(dateStr + 'T23:59:59').getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    const tbody = document.querySelector('#storeTable tbody');
    tbody.innerHTML = '';

    // Filter locations based on ALL dropdowns
    // Filter locations based on ALL dropdowns
    let filteredLocations = locationsCache;
    
    // If a specific location is selected, that overrides everything else
    if (selLocationId) {
        filteredLocations = locationsCache.filter(l => l.id === selLocationId);
    } 
    // Otherwise use Market/District filters
    else if (storeMetadataCache.length > 0 && (selMarket || selDistrict)) {
        filteredLocations = locationsCache.filter(loc => {
            const meta = getMetaForLoc(loc);
            if(!meta) return false;
            // ROBUST MATCHING: Use trim()
            if(selMarket && meta.market.trim() !== selMarket) return false;
            if(selDistrict && meta.district.trim() !== selDistrict) return false;
            return true;
        });
    }

    if(filteredLocations.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px;">No stores match the current filters.</td></tr>';
        overlay.style.display = 'none';
        return;
    }

    // Process concurrently in chunks to speed up loading
const chunkSize = 3; 
    for (let i = 0; i < filteredLocations.length; i += chunkSize) {
        const chunk = filteredLocations.slice(i, i + chunkSize);
        loadText.innerText = `Processing stores ${i + 1} - ${Math.min(i + chunkSize, filteredLocations.length)} of ${filteredLocations.length}`;

        await Promise.all(chunk.map(async (loc) => {
            try {
                const lists = await fetchListsForLocation(loc.id, startTs, endTs);
                
                // 1. Initialize rowData for the Grid
                let rowData = { name: loc.name, id: loc.id, dp1: { status: 'Missing', score: null }, dp3: { status: 'Missing', score: null }, dp5: { status: 'Missing', score: null }, sanitizer: 'OK' };
                
                // 2. FIX: Initialize locReport for the Drill-down/Modal
                let locReport = { id: loc.id, name: loc.name, lists: [] };

                let hasExpired = false; let hasExpiring = false; let hasWarning = false;

                lists.forEach(list => {
                    const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled");
                    const titleLower = title.toLowerCase();
                    
                    if (list.itemResults) {
                        const expStatus = checkExpirationStatus(list.itemResults);
                        if (expStatus.expired) hasExpired = true;
                        if (expStatus.expiring) hasExpiring = true;
                        if (expStatus.warning) hasWarning = true;
                    }
                    
                    if (titleLower.includes('dfsl') || titleLower.includes('fsl')) {
                        let bucket = null;
                        if (titleLower.includes('daypart 1')) bucket = 'dp1';
                        else if (titleLower.includes('daypart 3')) bucket = 'dp3';
                        else if (titleLower.includes('daypart 5')) bucket = 'dp5';

                        if (bucket) {
                            const stats = extractReportStats(list.itemResults);
                            
                            // 3. FIX: Now this works because locReport is defined above
                            locReport.lists.push({ type: bucket, title: title, stats: stats, itemResults: list.itemResults });
                            
                            let statusText = "In Progress";
                            if (list.incompleteCount === 0) statusText = "Complete";
                            else if (list.deadlineTimestamp > 0 && list.deadlineTimestamp < now) statusText = "Late";
                            
                            let integrityVal = "";
                            if (list.incompleteCount === 0 && list.itemResults) {
                                const dur = calculateDuration(list.itemResults);
                                const scoreData = calculateIntegrity(list.itemResults, title, dur.seconds);
                                if (scoreData.score !== null) integrityVal = scoreData.score + "%";
                            }
                            rowData[bucket].status = statusText;
                            rowData[bucket].score = integrityVal;
                        }
                    }
                });

                if (hasExpired) rowData.sanitizer = "EXPIRED";
                else if (hasExpiring) rowData.sanitizer = "Expiring";
                else if (hasWarning) rowData.sanitizer = "Warning";

                // 4. FIX: Save the report data to the global cache so the button click works later
                reportDataCache.push(locReport);
                
                gridDataCache.push(rowData);
                renderGridRow(tbody, rowData);

            } catch(e) { console.error(e); }
        }));
        await delay(500);
    }
    overlay.style.display = 'none';
}

// --- SAFETY GRID VIEW LOGIC (NEW FUNCTIONS) ---
// --- SAFETY GRID VIEW LOGIC ---
async function loadSafetyGrid() {
    const monthStr = document.getElementById('safetyMonth').value;
    
    // 1. GET VALUES (Use .trim() to clean accidental spaces)
    const rawMarket = document.getElementById('safetyMarketFilter').value || "";
    const rawDistrict = document.getElementById('safetyDistrictFilter').value || "";
    // This is the new ID we added in Step 1
    const rawLocationId = document.getElementById('safetyLocationFilter')?.value || "";

    const selMarket = rawMarket.trim();
    const selDistrict = rawDistrict.trim();

    if (!monthStr) { alert("Please select a month."); return; }
    
    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    overlay.style.display = 'flex';
    safetyGridDataCache = [];
    
    const [yyyy, mm] = monthStr.split('-');
    const startDate = new Date(parseInt(yyyy), parseInt(mm)-1, 1);
    const endDate = new Date(parseInt(yyyy), parseInt(mm), 0);
    const startTs = Math.floor(startDate.getTime() / 1000);
    const endTs = Math.floor(endDate.setHours(23,59,59) / 1000);

    const tbody = document.querySelector('#safetyTable tbody');
    tbody.innerHTML = '';

    // --- FILTER LOGIC START ---
    let filteredLocations = locationsCache;

    // A. If specific Location is selected, ignore Market/District
    if (rawLocationId) {
        filteredLocations = locationsCache.filter(l => l.id === rawLocationId);
    } 
    // B. Otherwise, filter by Market/District
    else if (storeMetadataCache.length > 0 && (selMarket || selDistrict)) {
        filteredLocations = locationsCache.filter(loc => {
            const meta = getMetaForLoc(loc); // Use the helper
            if(!meta) return false;
            
            // Check Market (Loose match)
            if(selMarket && meta.market.trim() !== selMarket) return false;
            
            // Check District (Loose match)
            if(selDistrict && meta.district.trim() !== selDistrict) return false;
            
            return true;
        });
    }
    // --- FILTER LOGIC END ---

    if(filteredLocations.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px;">No stores match the current filters.</td></tr>';
        overlay.style.display = 'none';
        return;
    }

    const chunkSize = 3; 
    for (let i = 0; i < filteredLocations.length; i += chunkSize) {
        const chunk = filteredLocations.slice(i, i + chunkSize);
        loadText.innerText = `Processing stores ${i + 1} - ${Math.min(i + chunkSize, filteredLocations.length)} of ${filteredLocations.length}`;
        
        await Promise.all(chunk.map(async (loc) => {
            try {
                const lists = await fetchListsForLocation(loc.id, startTs, endTs);
                
                // Find Audit (Case insensitive search)
                const auditList = lists.find(l => {
                    const t = (l.listTemplate && l.listTemplate.title) ? l.listTemplate.title.toLowerCase() : "";
                    return t.includes("monthly safety audit");
                });
                
                // Find Agenda (Case insensitive search)
                const agendaList = lists.find(l => {
                    const t = (l.listTemplate && l.listTemplate.title) ? l.listTemplate.title.toLowerCase() : "";
                    return t.includes("safety committee agenda");
                });

                let rowData = {
                    name: loc.name,
                    auditStatus: auditList ? (auditList.incompleteCount === 0 ? "Complete" : "In Progress") : "Missing",
                    auditScore: null,
                    agendaStatus: agendaList ? (agendaList.incompleteCount === 0 ? "Complete" : "In Progress") : "Missing"
                };

                if (auditList && auditList.score !== undefined) {
                    let max = auditList.maxPossibleScore;
                    if (!max) { const calc = getAuditScore(auditList.itemResults || []); max = calc.possible; }
                    rowData.auditScore = max > 0 ? Math.round((auditList.score / max) * 100) + "%" : "0%";
                }

                safetyGridDataCache.push(rowData);
                renderSafetyGridRow(tbody, rowData);
            } catch(e) { 
                console.error("Safety Grid Error " + loc.name, e);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td><strong>${loc.name}</strong></td><td colspan="3" style="color:red; text-align:center;">Error: ${e.message}</td>`;
                tbody.appendChild(tr);
            }
        }));
        await delay(500); 
    }
    overlay.style.display = 'none';
}

function renderSafetyGridRow(tbody, data) {
    const tr = document.createElement('tr');
    
    const getBadge = (status) => {
        let cls = "ls-missing";
        if (status === "Complete") cls = "ls-complete";
        else if (status === "In Progress") cls = "ls-progress";
        return `<span class="list-status ${cls}">${status}</span>`;
    };

    tr.innerHTML = `
        <td><strong>${data.name}</strong></td>
        <td>
            ${getBadge(data.auditStatus)} 
            ${data.auditScore ? `<div style="font-size:0.8rem; margin-top:4px;">Score: ${data.auditScore}</div>` : ''}
        </td>
        <td>${getBadge(data.agendaStatus)}</td>
        <td>
            ${(data.auditStatus === "Complete" && data.agendaStatus === "Complete") ? '✅' : '❌'}
        </td>
    `;
    tbody.appendChild(tr);
}

function printSafetyGrid() {
    const month = document.getElementById('safetyMonth').value;
    const m = document.getElementById('safetyMarketFilter').value || "All Markets";
    const d = document.getElementById('safetyDistrictFilter').value || "All Districts";
    
    let header = document.getElementById('safetyPrintHeader');
    if (!header) {
        header = document.createElement('div');
        header.id = 'safetyPrintHeader';
        header.className = 'only-print';
        header.style.marginBottom = '20px';
        header.style.textAlign = 'center';
        const table = document.querySelector('#safetyTable');
        table.parentNode.insertBefore(header, table);
    }
    
    header.innerHTML = `<h2>Safety Audit Grid</h2><p>Month: ${month} | Market: ${m} | District: ${d}</p>`;
    window.print();
}

function exportSafetyGridCSV() {
    if (!safetyGridDataCache || safetyGridDataCache.length === 0) { alert("No data to export."); return; }
    let csv = "Store Name,Monthly Audit Status,Audit Score,Agenda Status,Complete?\n";
    safetyGridDataCache.forEach(d => {
        const isComp = (d.auditStatus === "Complete" && d.agendaStatus === "Complete") ? "Yes" : "No";
        csv += `"${d.name}","${d.auditStatus}","${d.auditScore||''}","${d.agendaStatus}","${isComp}"\n`;
    });
    downloadCSV(csv, "jolt_safety_grid.csv");
}


// --- REPORT GENERATOR ---
// --- REPORT GENERATOR (DFSL 3-Column View) ---
// --- REPORT GENERATOR (Dynamic DFSL 3-Column View) ---
// --- REPORT GENERATOR (Cleaned & Dynamic) ---
// --- REPORT GENERATOR (Strict Schema & Deep Search) ---
// --- REPORT GENERATOR (2-Page Split & Smart Filtering) ---
// --- REPORT GENERATOR (Dynamic Flow - Single or Multi Page) ---
async function generateSingleReport() {
    const locId = document.getElementById('reportLocationSelect').value;
    const dateStr = document.getElementById('reportDate').value;
    if(!locId || !dateStr) { alert("Select location and date."); return; }
    
    // Setup Context
    const [yyyy, mm, dd] = dateStr.split('-');
    const reportDateObj = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));
    const dateFormatted = `${mm}-${dd}-${yyyy}`;
    const locName = document.getElementById('reportLocationSelect').options[document.getElementById('reportLocationSelect').selectedIndex].text;
    
    const startTs = Math.floor(reportDateObj.getTime() / 1000);
    const endTs = Math.floor(reportDateObj.setHours(23,59,59) / 1000);
    
    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    overlay.style.display = 'flex'; loadText.innerText = "Generating DFSL Report...";
    
    try {
        const lists = await fetchListsForLocation(locId, startTs, endTs);
        let buckets = { dp1: null, dp3: null, dp5: null };
        
        lists.forEach(list => {
            const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : "";
            const tLower = title.toLowerCase();
            if(tLower.includes('dfsl') || tLower.includes('fsl') || tLower.includes('food safety')) {
                if(tLower.includes('daypart 1')) buckets.dp1 = list;
                else if(tLower.includes('daypart 3')) buckets.dp3 = list;
                else if(tLower.includes('daypart 5')) buckets.dp5 = list;
            }
        });

        // FLATTEN DATA
        const flatDP1 = flattenListItems(buckets.dp1);
        const flatDP3 = flattenListItems(buckets.dp3);
        const flatDP5 = flattenListItems(buckets.dp5);

        const hasData = (keys) => {
            const check = (flatList) => flatList.some(i => {
                const t = i.cleanTitle.toLowerCase();
                return keys.some(k => t.includes(k.toLowerCase()));
            });
            return check(flatDP1) || check(flatDP3) || check(flatDP5);
        };

        // --- SINGLE PAGE CONTAINER ---
        let html = `
        <div class="report-page">
            <div class="report-header">
                <div class="report-brand">⚡ DFSL REPORT</div>
                <div class="report-meta">
                    <strong>Location:</strong> ${locName} &nbsp;|&nbsp; 
                    <strong>Date:</strong> ${dateFormatted}
                </div>
            </div>
            <table class="report-table">
                <thead>
                    <tr>
                        <th width="35%">Item</th>
                        <th width="21%">Daypart 1</th>
                        <th width="21%">Daypart 3</th>
                        <th width="21%">Daypart 5</th>
                    </tr>
                </thead>
                <tbody>
        `;

        // SECTION 1: CRITICAL DAILY FOCUS
        html += `<tr class="section-row"><td colspan="4">CRITICAL DAILY FOCUS</td></tr>`;
        const getComp = (list) => (!list) ? '<span class="dash">-</span>' : (list.incompleteCount === 0 ? 'Completed' : 'In Progress');
        html += `<tr><td><strong>Critical Focus Completed</strong></td><td>${getComp(buckets.dp1)}</td><td>${getComp(buckets.dp3)}</td><td class="blocked"></td></tr>`;

        html += renderRowFromFlat("Sanitizer Strength", ["Sanitizer Strength", "Quat", "PPM", "Solution"], flatDP1, flatDP3, flatDP5, reportDateObj, false, true); 
        html += renderRowFromFlat("Sanitizer Exp. Date", ["Exp. Date", "Expiration"], flatDP1, flatDP3, flatDP5, reportDateObj, true, true);
        html += renderRowFromFlat("Probe Calibration", ["Calibration", "Thermometer"], flatDP1, flatDP3, flatDP5, reportDateObj, false, true);

        // SECTION 2: BREAKFAST
        html += `<tr class="section-row"><td colspan="4">BREAKFAST PRODUCTS (DP1 Only)</td></tr>`;
        const breakfastItems = [
            { label: "Jr. Chicken Filet (Hold)", keys: ["Jr. Chicken", "Junior Chicken"] },
            { label: "Sausage Gravy / Carryover", keys: ["Gravy", "Carryover"] },
            { label: "Cooked Sausage", keys: ["Cooked Sausage"] },
            { label: "Swiss Cheese Sauce", keys: ["Swiss"] },
            { label: "Eggs", keys: ["Egg"] }
        ];
        breakfastItems.forEach(item => {
            if(hasData(item.keys)) {
                html += renderRowFromFlat(item.label, item.keys, flatDP1, flatDP3, flatDP5, reportDateObj, false, true, true);
            }
        });

        // SECTION 3: PRODUCT TEMPS
        html += `<tr class="section-row"><td colspan="4">PRODUCT TEMPERATURES</td></tr>`;
        const productItems = [
            { label: "Frosty Mix (Hopper)", keys: ["Frosty Mix", "Vanilla", "Chocolate"] },
            { label: "Chili", keys: ["Chili", "Chili:"] },
            { label: "Sliced Tomatoes", keys: ["Tomato"] },
            { label: "Lettuce", keys: ["Lettuce"] },
            { label: "Shredded Cheddar", keys: ["Cheddar", "Shredded"] },
            { label: "Bleu Cheese Crumbles", keys: ["Bleu Cheese"] },
            { label: "Cheese Sauce", keys: ["Cheese Sauce"] },
            { label: "Chicken Nuggets", keys: ["Nugget"] },
            { label: "Crispy Chicken", keys: ["Crispy"] },
            { label: "Spicy Chicken", keys: ["Spicy"] },
            { label: "Classic Chicken", keys: ["Classic", "Homestyle"] },
            { label: "Diced Chicken", keys: ["Diced"] },
            { label: "Chili Meat", keys: ["Chili Meat"] },
            { label: "Cooked Meat (Flat Grill)", keys: ["Flat Grill", "Cooked Meat Patty-Flat"] },
            { label: "Cooked Meat (DSG)", keys: ["DSG", "Cooked Meat Patty-DSG"] },
            { label: "Panned Small Meat", keys: ["Panned Small", "Raw", "Panned"] }
        ];
        productItems.forEach(item => {
            if(hasData(item.keys)) {
                html += renderRowFromFlat(item.label, item.keys, flatDP1, flatDP3, flatDP5, reportDateObj, false, false, false, true);
            }
        });

        // SECTION 4: EQUIPMENT TEMPS
        html += `<tr class="section-row"><td colspan="4">EQUIPMENT TEMPERATURES</td></tr>`;
        const equipItems = [
            { label: "Walk-in Freezer", keys: ["Walk-in Freezer"] },
            { label: "Walk-in Cooler", keys: ["Walk-in Cooler"] },
            { label: "Meat Well", keys: ["Meat Well"] },
            { label: "Reach-in Freezer", keys: ["Reach-in Freezer", "Upright Freezer"] },
            { label: "Salad Reach-in/Upright", keys: ["Salad Reach-in", "Salad Upright"] },
            { label: "Sandwich Station (Side 1/DT)", keys: ["Sandwich Station (PUW", "Side 1", "DT"] },
            { label: "Sandwich Station (Side 2/Lobby)", keys: ["Sandwich Station (Side 2", "Lobby", "Dine"] },
            { label: "Misc. Cooler", keys: ["Misc. Cooler", "Misc Cooler"] },
            { label: "Misc. Freezer", keys: ["Misc. Freezer", "Misc Freezer"] },
            { label: "Fry Station", keys: ["Fry Station"] },
            { label: "CA / Controlled Atmosphere", keys: ["CA ", "Controlled Atmosphere"] }
        ];

        equipItems.forEach(item => {
            if(hasData(item.keys)) {
                html += renderRowFromFlat(item.label, item.keys, flatDP1, flatDP3, flatDP5, reportDateObj);
            }
        });
        
        // CLOSE TABLE & CONTAINER
        html += `</tbody></table></div>`; 

        document.getElementById('reportContent').innerHTML = html;

    } catch(e) { 
        console.error(e); 
        document.getElementById('reportContent').innerHTML = `<div style="color:red; padding:20px;">Error: ${e.message}</div>`;
    }
    overlay.style.display = 'none';
}

// --- HELPER 1: DEEP RECURSIVE FLATTENER ---
// This ignores structure and grabs ALL data points
function flattenListItems(list) {
    let items = [];
    if(!list || !list.itemResults) return items;

    const traverse = (nodes) => {
        nodes.forEach(node => {
            // 1. RECURSE FIRST: Dive into sublists immediately
            if (node.subList && node.subList.itemResults) {
                traverse(node.subList.itemResults);
            }

            // 2. CAPTURE DATA: If this node has a value, keep it.
            // We ignore empty containers.
            const hasValue = node.resultValue || (node.resultDouble !== null && node.resultDouble !== undefined) || node.isMarkedNA;
            
            if (hasValue) {
                // Pre-clean the title for easier matching later
                let raw = (node.itemTemplate && node.itemTemplate.text) ? node.itemTemplate.text : "";
                
                // CLEANING LOGIC: Remove Markdown #, *, and Min/Max text
                // Example: "### Eggs *** ###### Min: 160" -> "Eggs"
                let clean = raw.replace(/[#*]/g, ''); 
                clean = clean.split('Min:')[0];
                clean = clean.split('Max:')[0];
                clean = clean.split('Range:')[0];
                clean = clean.trim();

                items.push({ 
                    node: node, 
                    cleanTitle: clean,
                    rawTitle: raw
                });
            }
        });
    };
    traverse(list.itemResults);
    return items;
}

// --- HELPER 2: ROW RENDERER FROM FLAT DATA ---
// --- HELPER 2: ROW RENDERER (Smart Priority: Numbers > Text) ---
// --- HELPER 2: ROW RENDERER (Smart Priority & Manual Highlight) ---
function renderRowFromFlat(label, keywords, flatDP1, flatDP3, flatDP5, reportDateObj, isDateCheck = false, blockDP5 = false, blockDP3 = false, blockDP1 = false) {
    
    // Helper to pick the best value from a list of matches
    const getBestMatch = (flatItems) => {
        if (!flatItems || flatItems.length === 0) return null;

        const candidates = flatItems.filter(i => {
            const t = i.cleanTitle.toLowerCase();
            return keywords.some(k => t.includes(k.toLowerCase()));
        });

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            const valA = a.node.resultDouble;
            const valB = b.node.resultDouble;
            const textA = (a.node.resultValue || "").toLowerCase();
            const textB = (b.node.resultValue || "").toLowerCase();
            const isJunk = (txt) => ['yes', 'no', 'true', 'false', '1', '0', 'pass', 'fail', 'completed'].includes(txt);

            const hasNumA = (valA !== null && valA !== undefined);
            const hasNumB = (valB !== null && valB !== undefined);
            if (hasNumA && !hasNumB) return -1; 
            if (!hasNumA && hasNumB) return 1;  

            const junkA = isJunk(textA);
            const junkB = isJunk(textB);
            if (!junkA && junkB) return -1; 
            if (junkA && !junkB) return 1;

            return 0; 
        });

        return candidates[0].node;
    };

    const getCell = (flatItems, isBlocked) => {
        if (isBlocked) return '<td class="blocked"></td>';
        
        const node = getBestMatch(flatItems);
        
        if (!node) return '<td><span class="dash">-</span></td>';
        if (node.isMarkedNA) return '<td>N/A</td>';

        // --- ICON & HIGHLIGHT LOGIC ---
        let icon = '<span class="icon-calc" title="Manual">⌨️</span>';
        let isManual = true; // Default to manual

        if (node.peripheral && node.peripheral.type === 'TEMPERATURE_PROBE') {
            icon = '<span class="icon-probe" title="Probe">🌡️</span>';
            isManual = false;
        } else if (node.source === 'sensor' || (node.peripheral && node.peripheral.type === 'SENSOR')) {
            icon = '<span class="icon-sensor" title="Sensor">📡</span>';
            isManual = false;
        }

        // Value Selection
        let val = (node.resultDouble !== null && node.resultDouble !== undefined) 
                  ? node.resultDouble 
                  : (node.resultValue || node.resultText || "-");
        
        let styleClass = "";

        if (typeof val === 'number' && val % 1 !== 0) val = val.toFixed(1);

        // Date Logic (Takes Priority over Manual Highlight)
        if (isDateCheck && node.resultDouble > 0) {
            const expDate = new Date(node.resultDouble * 1000);
            expDate.setHours(0,0,0,0);
            
            const today = new Date(reportDateObj); 
            today.setHours(0,0,0,0);
            
            const sevenDays = new Date(today);
            sevenDays.setDate(today.getDate() + 7);
            
            val = formatDateMMDDYYYY(expDate);

            if (expDate < today) styleClass = "cell-expired"; 
            else if (expDate.getTime() === today.getTime()) styleClass = "cell-today"; 
            else if (expDate <= sevenDays) styleClass = "cell-warning"; 
            
            icon = ""; 
            isManual = false; // Don't highlight dates as manual
        }

        // Apply Manual Highlight (Only if no other style is set)
        if (isManual && styleClass === "") {
            styleClass = "cell-manual";
        }

        return `<td class="${styleClass}">${val} ${icon}</td>`;
    };

    return `<tr>
        <td class="row-label">${label}</td>
        ${getCell(flatDP1, blockDP1)}
        ${getCell(flatDP3, blockDP3)}
        ${getCell(flatDP5, blockDP5)}
    </tr>`;
}

// UPDATED HELPER: Renders row with title cleaning inside the lookup
function renderReportRow(label, keywords, buckets, reportDateObj, isDateCheck = false, blockDP5 = false, blockDP3 = false, blockDP1 = false) {
    
    // Clean label for display
    const displayLabel = label.replace(/[#*]/g, '').trim();

    const getCell = (list, isBlocked) => {
        if (isBlocked) return '<td class="blocked"></td>';
        if (!list) return '<td><span class="dash">-</span></td>';
        
        let found = null;
        // Deep scan to find item matching keyword, cleaning titles as we go
        const scan = (items) => {
            for(let i of items) {
                // If it's a sublist container, check children
                if(i.subList && i.subList.itemResults) {
                    scan(i.subList.itemResults);
                    if(found) return;
                } else {
                    // It's a leaf item
                    const rawTxt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : "";
                    const cleanTxt = rawTxt.replace(/[#*]/g, '').trim().toLowerCase();
                    
                    // Check if ANY keyword matches the clean text
                    if(keywords.some(k => cleanTxt.includes(k.replace(/[#*]/g, '').trim().toLowerCase()))) { 
                        found = i; 
                        return; 
                    }
                }
            }
        };
        if(list.itemResults) scan(list.itemResults);
        
        if (!found) return '<td><span class="dash">-</span></td>';
        if (found.isMarkedNA) return '<td>N/A</td>';

        let icon = '<span class="icon-calc" title="Manual/Calculated">⌨️</span>';
        if (found.peripheral && found.peripheral.type === 'TEMPERATURE_PROBE') {
            icon = '<span class="icon-probe" title="Probe Used">🌡️</span>';
        } else if (found.source === 'sensor' || (found.peripheral && found.peripheral.type === 'SENSOR')) {
            icon = '<span class="icon-sensor" title="Sensor Reading">📡</span>';
        }

        let val = found.resultValue || found.resultDouble || found.resultText || "-";
        let styleClass = "";
        
        if (typeof val === 'number' && val % 1 !== 0) val = val.toFixed(1);

        if (isDateCheck && found.resultDouble > 0) {
            const expDate = new Date(found.resultDouble * 1000);
            expDate.setHours(0,0,0,0);
            const today = new Date(reportDateObj); 
            today.setHours(0,0,0,0);
            const sevenDays = new Date(today);
            sevenDays.setDate(today.getDate() + 7);
            
            val = formatDateMMDDYYYY(expDate);

            if (expDate < today) styleClass = "cell-expired"; 
            else if (expDate.getTime() === today.getTime()) styleClass = "cell-today"; 
            else if (expDate <= sevenDays) styleClass = "cell-warning"; 
            icon = ""; 
        }

        return `<td class="${styleClass}">${val} ${icon}</td>`;
    };

    return `<tr>
        <td class="row-label">${displayLabel}</td>
        ${getCell(buckets.dp1, blockDP1)}
        ${getCell(buckets.dp3, blockDP3)}
        ${getCell(buckets.dp5, blockDP5)}
    </tr>`;
}

// HELPER: Renders a single row for the report
function renderReportRow(label, keywords, buckets, reportDateObj, isDateCheck = false, blockDP5 = false, blockDP3 = false, blockDP1 = false) {
    
    const getCell = (list, isBlocked) => {
        if (isBlocked) return '<td class="blocked"></td>';
        if (!list) return '<td><span class="dash">-</span></td>';
        
        // Find Item
        let found = null;
        const scan = (items) => {
            for(let i of items) {
                const txt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text.toLowerCase() : "";
                if(keywords.some(k => txt.includes(k.toLowerCase()))) { found = i; return; }
                if(i.subList && i.subList.itemResults) scan(i.subList.itemResults);
                if(found) return;
            }
        };
        if(list.itemResults) scan(list.itemResults);
        
        if (!found) return '<td><span class="dash">-</span></td>';
        if (found.isMarkedNA) return '<td>N/A</td>';

        // --- ICON LOGIC ---
        let icon = '<span class="icon-calc" title="Manual/Calculated">⌨️</span>'; // Default: Manual
        if (found.peripheral && found.peripheral.type === 'TEMPERATURE_PROBE') {
            icon = '<span class="icon-probe" title="Probe Used">🌡️</span>';
        } else if (found.source === 'sensor' || (found.peripheral && found.peripheral.type === 'SENSOR')) {
            // Future proofing for sensors
            icon = '<span class="icon-sensor" title="Sensor Reading">📡</span>';
        }

        // --- VALUE DISPLAY ---
        let val = found.resultValue || found.resultDouble || found.resultText || "-";
        let styleClass = "";
        
        // Round decimals
        if (typeof val === 'number' && val % 1 !== 0) val = val.toFixed(1);

        // --- DATE CHECK LOGIC (Sanitizer) ---
        if (isDateCheck && found.resultDouble > 0) {
            // Convert Jolt Timestamp to Date
            // Use the REPORT DATE (00:00:00) as the anchor
            const expDate = new Date(found.resultDouble * 1000);
            expDate.setHours(0,0,0,0);
            
            const today = new Date(reportDateObj); // Clone report date
            today.setHours(0,0,0,0);
            
            const sevenDays = new Date(today);
            sevenDays.setDate(today.getDate() + 7);
            
            val = formatDateMMDDYYYY(expDate);

            if (expDate < today) styleClass = "cell-expired"; // Red
            else if (expDate.getTime() === today.getTime()) styleClass = "cell-today"; // Orange
            else if (expDate <= sevenDays) styleClass = "cell-warning"; // Yellow
            
            // Remove icon for dates, it's clutter
            icon = ""; 
        }

        return `<td class="${styleClass}">${val} ${icon}</td>`;
    };

    return `<tr>
        <td class="row-label">${label}</td>
        ${getCell(buckets.dp1, blockDP1)}
        ${getCell(buckets.dp3, blockDP3)}
        ${getCell(buckets.dp5, blockDP5)}
    </tr>`;
}

function renderGridRow(tbody, data) {
    const tr = document.createElement('tr');
    const renderCell = (cellData) => {
        let statusClass = "ls-missing";
        if (cellData.status === "Complete") statusClass = "ls-complete";
        else if (cellData.status === "Late") statusClass = "ls-late";
        else if (cellData.status === "In Progress") statusClass = "ls-progress";
        let html = `<div class="grid-cell-content"><span class="list-status ${statusClass}">${cellData.status}</span>`;
        if (cellData.score) {
                let color = "green"; const num = parseInt(cellData.score);
                if (num < 60) color = "red"; else if (num < 85) color = "#b8860b";
                html += `<span class="grid-score" style="color:${color}">🛡️ ${cellData.score}</span>`;
        }
        html += `</div>`;
        return html;
    };
    let sanHtml = `<span style="color:green; font-weight:bold;">OK</span>`;
    if (data.sanitizer === "EXPIRED") sanHtml = `<span style="color:white; background:red; padding:3px 6px; border-radius:4px; font-weight:bold;">EXPIRED 🔴</span>`;
    else if (data.sanitizer === "Expiring") sanHtml = `<span style="color:black; background:gold; padding:3px 6px; border-radius:4px; font-weight:bold;">Expiring 🟡</span>`;
    else if (data.sanitizer === "Warning") sanHtml = `<span style="color:white; background:orange; padding:3px 6px; border-radius:4px; font-weight:bold;">Next 7 Days 🟠</span>`;
    tr.innerHTML = `<td><strong>${data.name}</strong></td><td>${renderCell(data.dp1)}</td><td>${renderCell(data.dp3)}</td><td>${renderCell(data.dp5)}</td><td>${sanHtml}</td>`;
    tbody.appendChild(tr);
}

// --- PRINT & EXPORT ---
// --- UPDATED PRINT FUNCTIONS (Date Fix) ---

function printGrid() {
    const rawDate = document.getElementById('gridDate').value; // YYYY-MM-DD
    const m = document.getElementById('marketFilter').value || "All Markets";
    const d = document.getElementById('districtFilter').value || "All Districts";
    
    // FORMAT: MM-DD-YYYY
    let displayDate = rawDate;
    if (rawDate && rawDate.includes('-')) {
        const [yyyy, mm, dd] = rawDate.split('-');
        displayDate = `${mm}-${dd}-${yyyy}`;
    }
    
    let header = document.getElementById('gridPrintHeader');
    if (!header) {
        header = document.createElement('div');
        header.id = 'gridPrintHeader';
        header.className = 'only-print';
        header.style.marginBottom = '20px';
        header.style.textAlign = 'center';
        const table = document.querySelector('#storeTable');
        table.parentNode.insertBefore(header, table);
    }
    header.innerHTML = `<h2>DFSL Grid</h2><p>Date: ${displayDate} | Market: ${m} | District: ${d}</p>`;
    window.print();
}

function printSafetyGrid() {
    const rawMonth = document.getElementById('safetyMonth').value; // YYYY-MM
    const m = document.getElementById('safetyMarketFilter').value || "All Markets";
    const d = document.getElementById('safetyDistrictFilter').value || "All Districts";
    
    // FORMAT: MM-YYYY
    let displayMonth = rawMonth;
    if (rawMonth && rawMonth.includes('-')) {
        const [yyyy, mm] = rawMonth.split('-');
        displayMonth = `${mm}-${yyyy}`;
    }
    
    let header = document.getElementById('safetyPrintHeader');
    if (!header) {
        header = document.createElement('div');
        header.id = 'safetyPrintHeader';
        header.className = 'only-print';
        header.style.marginBottom = '20px';
        header.style.textAlign = 'center';
        const table = document.querySelector('#safetyTable');
        table.parentNode.insertBefore(header, table);
    }
    
    header.innerHTML = `<h2>Safety Audit Grid</h2><p>Month: ${displayMonth} | Market: ${m} | District: ${d}</p>`;
    window.print();
}

function exportGridToCSV() {
    if (!gridDataCache || gridDataCache.length === 0) { alert("No grid data to export."); return; }
    let csv = "Store Name,DP1 Status,DP1 Integrity,DP3 Status,DP3 Integrity,DP5 Status,DP5 Integrity,Sanitizer Issues\n";
    gridDataCache.forEach(d => { csv += `"${d.name}","${d.dp1.status}","${d.dp1.score||''}","${d.dp3.status}","${d.dp3.score||''}","${d.dp5.status}","${d.dp5.score||''}","${d.sanitizer}"\n`; });
    downloadCSV(csv, "jolt_store_grid_overview.csv");
}

async function fetchListsForLocation(locationId, start, end) {
    const ITEM_FIELDS = `id type __typename resultValue resultText resultDouble isMarkedNA completionTimestamp resultAssets { id name } resultCompanyFiles { fileURI } peripheral { type } itemTemplate { text type isScoringItemType isRequired } notes { body }`;
    const query = `query GetChecklists($filter: ListInstancesFilter!) { listInstances(filter: $filter) { id displayTimestamp deadlineTimestamp incompleteCount isActive instanceTitle score maxPossibleScore listTemplate { title } itemResults { ${ITEM_FIELDS} subList { id instanceTitle itemResults { ${ITEM_FIELDS} subList { id instanceTitle itemResults { ${ITEM_FIELDS} subList { id instanceTitle itemResults { ${ITEM_FIELDS} } } } } } } } } }`;
    const variables = { filter: { locationIds: [locationId], displayAfterTimestamp: start, displayBeforeTimestamp: end, isSublist: false } };
    try { const data = await joltFetch(query, variables); return data.data?.listInstances || []; } catch(e) { console.error(e); return []; }
}

async function renderListDetails(listData, containerId = 'detailView') {
    const container = document.getElementById(containerId);
    if (!container) return; 
    const listName = (listData.listTemplate && listData.listTemplate.title) ? listData.listTemplate.title : (listData.instanceTitle || "Checklist");
    const titleLower = listName.toLowerCase();
    const isAuditOrAgenda = titleLower.includes('audit') || titleLower.includes('agenda');

    const dateObj = listData.displayTimestamp ? ((listData.displayTimestamp > 9999999999) ? new Date(listData.displayTimestamp) : new Date(listData.displayTimestamp * 1000)) : new Date();
    const dateStr = formatDateMMDDYYYY(dateObj);

    let headerHtml = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
            <div>
                <h3 style="margin:0;">${listName}</h3>
                <div style="font-size:12px; color:#555; margin-top:4px;">Date: ${dateStr}</div>
            </div>
            <button class="btn-secondary no-print" style="padding:5px 10px; font-size:0.8rem;" onclick='exportListDetails(${JSON.stringify(listData.id)})'>Export List Details</button>
        </div>`;
    
    // --- FIX: Use 'audit-score-header' class so it PRINTS ---
    if (isAuditOrAgenda && !titleLower.includes('agenda') && listData.score !== undefined && listData.score !== null) {
        let max = listData.maxPossibleScore;
        if (!max) { const calculatedStats = getAuditScore(listData.itemResults || []); max = calculatedStats.possible; }
        const pct = max > 0 ? Math.round((listData.score / max) * 100) : 0;
        
        // This class is NOT hidden by the print CSS
        headerHtml += `<div class="audit-score-header" style="margin-top:5px; padding-bottom:10px; border-bottom:1px solid #eee;"><strong>🏆 Audit Score:</strong> ${pct}% (${listData.score}/${max})</div>`;
    }

    container.innerHTML = headerHtml;
    window.currentDetailList = listData;
    const items = listData.itemResults || [];
    if (items.length === 0) { container.innerHTML += `<p>No items found.</p>`; return; }
    
    const durationInfo = calculateDuration(items);
    let durationHtml = "";
    if (durationInfo.text && !isAuditOrAgenda) durationHtml = `<div><strong>⏱️ Total Time:</strong> ${durationInfo.text}</div>`;
    
    let integrityHtml = "";
    const targetLists = ['🟧', 'DFSL', 'FSL', 'Food Safety'];
    const isTargetList = targetLists.some(tag => listName.includes(tag));
    
    if (isTargetList && listData.incompleteCount === 0 && !isAuditOrAgenda) {
        const scoreData = calculateIntegrity(items, listName, durationInfo.seconds);
        let badgeClass = 'integrity-high';
        let scoreDisplay = scoreData.score + "%";
        if (scoreData.score === null) { badgeClass = 'integrity-na'; scoreDisplay = "N/A"; }
        else if (scoreData.score < 60) badgeClass = 'integrity-low';
        else if (scoreData.score < 85) badgeClass = 'integrity-med';
        integrityHtml = `<div class="integrity-score ${badgeClass}">🛡️ Integrity Score: ${scoreDisplay} <span style="font-weight:normal; font-size:0.8rem; margin-left:10px;">(${scoreData.issues.join(', ') || 'Looks Good'})</span></div>`;
    }
    
    // Keep duration/integrity in the meta container (which gets hidden on print)
    if (!isAuditOrAgenda && (durationHtml || integrityHtml)) container.innerHTML += `<div class="checklist-meta">${durationHtml} ${integrityHtml}</div>`;
    
    const listContainer = document.createElement('div');
    items.forEach(item => { const el = createItemElement(item, isTargetList, isAuditOrAgenda); if (el) listContainer.appendChild(el); });
    container.appendChild(listContainer);
}

function createItemElement(itemResult, isParentTargetList, hideNA = false) {
    if (hideNA && itemResult.isMarkedNA) return null;
    const typeUpper = (itemResult.type || "").toUpperCase();
    const templateTypeUpper = ((itemResult.itemTemplate && itemResult.itemTemplate.type) || "").toUpperCase();
    if (typeUpper === 'TEXT' || templateTypeUpper === 'TEXT') return null;
    
    const div = document.createElement('div');
    let prompt = "Unknown Item";
    if (itemResult.itemTemplate && itemResult.itemTemplate.text) prompt = itemResult.itemTemplate.text; 
    else prompt = `Item ID: ${itemResult.id}`;
    
    let entryClass = "checklist-entry";
    
    // Expiration Logic
    const isExpItem = prompt.includes("Sanitizer") && prompt.includes("Exp. Date");
    if (isExpItem && itemResult.resultDouble) {
        const today = new Date(); today.setHours(0,0,0,0);
        const expDate = new Date(itemResult.resultDouble * 1000); expDate.setHours(0,0,0,0);
        const sevenDays = new Date(); sevenDays.setDate(today.getDate() + 7); sevenDays.setHours(0,0,0,0);
        if (expDate < today) entryClass += " expired-item";
        else if (expDate.getTime() === today.getTime()) entryClass += " expiring-item";
        else if (expDate <= sevenDays) entryClass += " expiring-item";
    }

    if (prompt.trim().toLowerCase().startsWith("note")) {
        entryClass += " is-note-item";
    }

    const hasSublist = itemResult.subList && itemResult.subList.itemResults && itemResult.subList.itemResults.length > 0;
    if (hasSublist) {
        entryClass += " has-sublist";
    }

    div.className = entryClass;
    
    let displayValue = ""; let statusClass = "status-pending"; let statusText = "TODO";
    let photoAsset = null; let photoUrl = null;
    const isPhotoType = typeUpper.includes('PHOTO') || templateTypeUpper.includes('PHOTO');
    const completed = itemResult.completionTimestamp && itemResult.completionTimestamp > 0;
    
    if (completed) { statusClass = "status-pass"; statusText = "DONE"; }
    
    if (itemResult.isMarkedNA) { displayValue = "N/A"; statusClass = "status-na"; statusText = "N/A"; }
    else if (isPhotoType) {
        if (itemResult.resultCompanyFiles && itemResult.resultCompanyFiles.length > 0) { 
            photoUrl = itemResult.resultCompanyFiles[0].fileURI; 
            if (itemResult.resultAssets && itemResult.resultAssets.length > 0) photoAsset = itemResult.resultAssets[0]; 
        } 
        else if (itemResult.resultAssets && itemResult.resultAssets.length > 0) { photoAsset = itemResult.resultAssets[0]; } 
        else if (!completed) statusText = "NO PHOTO";
    } else if (itemResult.resultDouble) {
            const isDateType = typeUpper.includes('DATE') || typeUpper.includes('TIME');
            if (isDateType || prompt.toLowerCase().includes('date')) { 
                if (itemResult.resultDouble > 946684800) {
                     // --- FIX: Use Standard Date Helper MM-DD-YYYY ---
                     displayValue = formatDateMMDDYYYY(itemResult.resultDouble);
                } 
                else displayValue = itemResult.resultDouble; 
            } else displayValue = itemResult.resultDouble;
    } else if (itemResult.resultValue) displayValue = itemResult.resultValue;
    else if (itemResult.resultText) displayValue = itemResult.resultText;
    
    let valDisplay = displayValue;
    if (itemResult.peripheral && itemResult.peripheral.type === 'TEMPERATURE_PROBE') valDisplay += ' 🌡️';

    let photoBtnHtml = '';
    const escapeStr = (str) => { if(!str) return ""; return str.replace(/['"\r\n]/g, " ").trim(); };
    if (photoUrl) { const safePrompt = escapeStr(prompt); photoBtnHtml = `<button class="photo-btn no-print" onclick="showPhoto('${safePrompt}', null, '${photoUrl}')">View Photo</button>`; } 
    else if (photoAsset) { const safeName = escapeStr(photoAsset.name); photoBtnHtml = `<button class="photo-btn no-print" onclick="showPhoto('${safeName}', '${photoAsset.id}', null)">View Photo Info</button>`; }

    let html = `<div class="entry-header"><span class="entry-title">${prompt}</span><div class="entry-right" style="display:flex; align-items:center;">${valDisplay ? `<span class="entry-value">${valDisplay}</span>` : ''}${photoBtnHtml}<span class="status-badge ${statusClass}" style="margin-left:10px;">${statusText}</span></div></div>`;
    
    if (itemResult.notes && itemResult.notes.length > 0) { 
        itemResult.notes.forEach(note => { if (note.body) html += `<div class="entry-notes">📝 ${note.body}</div>`; }); 
    }
    div.innerHTML = html;

    if (hasSublist) {
        const subContainer = document.createElement('div'); 
        subContainer.className = 'sublist-container';
        const subTitle = prompt; 
        
        let subIntegrityHtml = "";
        let subTimestamps = [];
        const collectSubTimestamps = (list) => { list.forEach(si => { if(si.completionTimestamp > 0) subTimestamps.push(si.completionTimestamp); }); }
        collectSubTimestamps(itemResult.subList.itemResults);
        
        let subSeconds = null; let subDurationStr = "";
        if (subTimestamps.length >= 2) {
            subTimestamps.sort((a,b) => a-b); subSeconds = subTimestamps[subTimestamps.length-1] - subTimestamps[0];
            const mins = Math.floor(subSeconds / 60); const secs = subSeconds % 60;
            subDurationStr = `<span class="duration-tag">⏱️ ${mins}m ${secs}s</span>`;
        }
        
        if (isParentTargetList && subTimestamps.length >= 2) {
            const subScore = calculateIntegrity(itemResult.subList.itemResults, prompt, subSeconds); 
            let badgeClass = 'integrity-high'; let scoreDisplay = subScore.score + "%";
            if (subScore.score === null) { badgeClass = 'integrity-na'; scoreDisplay = "N/A"; }
            else if (subScore.score < 60) badgeClass = 'integrity-low';
            else if (subScore.score < 85) badgeClass = 'integrity-med';
            subIntegrityHtml = `<span class="integrity-badge ${badgeClass}" style="font-size:0.7rem; margin-left:8px;">🛡️ ${scoreDisplay}</span>`;
        }
        
        subContainer.innerHTML = `<div class="sublist-header"><span>${subTitle} ${subIntegrityHtml}</span> ${subDurationStr}</div>`;
        itemResult.subList.itemResults.forEach(subItem => { 
            const subEl = createItemElement(subItem, isParentTargetList, hideNA); 
            if (subEl) subContainer.appendChild(subEl); 
        });
        div.appendChild(subContainer);
    }
    return div;
}
function downloadCSV(csvContent, filename) { const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); if (link.download !== undefined) { const url = URL.createObjectURL(blob); link.setAttribute("href", url); link.setAttribute("download", filename); link.style.visibility = 'hidden'; document.body.appendChild(link); link.click(); document.body.removeChild(link); } }
function exportCurrentView() { 
    if (!currentListsCache || currentListsCache.length === 0) { alert("No data."); return; }
    let csv = "Location,Checklist Name,Date,Status,Duration,Integrity Score\n";
    currentListsCache.forEach(list => { const comp = list._computed || {}; const title = (list.listTemplate && list.listTemplate.title) ? list.listTemplate.title : (list.instanceTitle || "Untitled"); const d = list.displayTimestamp ? new Date(list.displayTimestamp * 1000).toLocaleString() : ""; const cleanTitle = `"${title.replace(/"/g, '""')}"`; const cleanLoc = `"${(comp.locationName || "").replace(/"/g, '""')}"`; csv += `${cleanLoc},${cleanTitle},${d},${comp.status},${comp.duration},${comp.integrity}\n`; });
    downloadCSV(csv, "jolt_export_current_view.csv");
}
function exportListDetails(listId) {
    if(!window.currentDetailList || window.currentDetailList.id !== listId) return;
    const list = window.currentDetailList;
    const items = list.itemResults || [];
    let csv = "Item,Value,Status,Notes\n";
    
    const scan = (nodes) => {
        nodes.forEach(i => {
            const prompt = (i.itemTemplate && i.itemTemplate.text) ? i.itemTemplate.text : (i.instanceTitle || "Item");
            let val = "";
            if (i.isMarkedNA) val = "N/A";
            else if (i.resultValue) val = i.resultValue;
            else if (i.resultDouble) val = i.resultDouble;
            
            let status = (i.completionTimestamp > 0) ? "Done" : "Pending";
            let notes = "";
            if(i.notes) notes = i.notes.map(n => n.body).join(" | ");
            
            csv += `"${prompt.replace(/"/g, '""')}","${val}","${status}","${notes.replace(/"/g, '""')}"\n`;
            if(i.subList && i.subList.itemResults) scan(i.subList.itemResults);
        });
    };
    scan(items);
    downloadCSV(csv, `jolt_details_${listId}.csv`);
}
function showPhoto(name, id, url) { 
    const modal = document.getElementById('photoModal'); const cap = document.getElementById('photoCaption'); const title = document.getElementById('photoTitle'); const placeholder = document.querySelector('.photo-placeholder');
    placeholder.style.display = 'flex'; placeholder.innerHTML = '<span>Image Preview Unavailable via API</span>';
    const existingImg = modal.querySelector('img.dynamic-photo'); if(existingImg) existingImg.remove();
    title.innerText = "Photo: " + (name || "Unknown");
    if (url) {
        placeholder.style.display = 'none'; const img = document.createElement('img'); img.src = url; img.className = 'dynamic-photo'; img.style.maxWidth = '100%'; img.style.maxHeight = '80vh';
        title.insertAdjacentElement('afterend', img); cap.innerText = "";
    } else { cap.innerText = `Asset ID: ${id}`; }
    modal.style.display = 'flex'; 
}
function closePhoto() { document.getElementById('photoModal').style.display = 'none'; }
async function joltFetch(query, variables = {}, retries = 3) { 
    const url = config.proxyUrl; 
    const payload = { query: query, variables: variables }; 
    
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, { 
                method: 'POST', 
                headers: HEADERS, 
                body: JSON.stringify(payload) 
            }); 

            const text = await response.text();

            // Check for HTTP errors (404, 500, 502, etc.)
            if (!response.ok) {
                // If it's the last retry, throw the error
                if (i === retries - 1) {
                    throw new Error(`API Error (${response.status}): ${text.substring(0, 50)}...`);
                }
                // Otherwise, throw specific error to trigger catch block below
                throw new Error(`Attempt ${i+1} failed: ${response.status}`);
            }

            try {
                const result = JSON.parse(text);
                if (result.errors) throw new Error(result.errors.map(e => e.message).join(", "));
                return result; // Success!
            } catch (jsonError) {
                // If we got HTML (the "<" error), it's a proxy timeout. Retry.
                if (i === retries - 1) throw new Error("Proxy Timeout: Received HTML instead of data.");
                throw new Error("Invalid JSON received");
            }

        } catch (err) {
            // If we have retries left, wait and loop again
            if (i < retries - 1) {
                console.warn(`Fetch failed (${err.message}). Retrying in ${(i+1)*1000}ms...`);
                await delay((i + 1) * 1000); // Wait 1s, then 2s, then 3s
            } else {
                throw err; // Out of retries, crash.
            }
        }
    }
}
function handleError(err, context) { log(`Error ${context}: ${err.message}`, 'error'); }
function openConfig() { document.getElementById('configModal').style.display = 'flex'; document.getElementById('cfg-url').value = config.proxyUrl; }
function saveConfig() { config.proxyUrl = document.getElementById('cfg-url').value; document.getElementById('configModal').style.display = 'none'; fetchLocations(); }
function loadConfigUI() { document.getElementById('cfg-url').value = config.proxyUrl; }

/* --- PROBE & SENSOR LOGIC (V4 - Fixed Sorting Race Condition) --- */

// Configuration
const PROBE_CONTENT_GROUP_ID = "Q29udGVudEdyb3VwOjAwMDU4NzViMjYwZDRjNmI2NDdhNjBjZDAxNDFlZDU2";
const PROBE_TEMPLATE_IDS = [
    "TGlzdFRlbXBsYXRlOjExZWVkNzhmNWQ0MTRkODBhZDlhZmE1NWZjZDk3MmNm", "TGlzdFRlbXBsYXRlOjExZWY5ZWJjNTczMDU0MDA4ODliMjJlZjM3YzAxNjU0",
    "TGlzdFRlbXBsYXRlOjExZWY5ZTYyZjI0NDRhMDBhYjFiOWFiZmE2ZDU2OTg3", "TGlzdFRlbXBsYXRlOjExZWY0NTc5MTJlZjU5OTBhMmIzNDJjNDg1OTU5NzJj",
    "TGlzdFRlbXBsYXRlOjExZWY0NTdhNmZiMWUxYjBhZDMwY2VmNzM2N2UyZTdl", "TGlzdFRlbXBsYXRlOjExZWY0NTdhZDQ4MmMwMDBiZGUwZTIyMGU0OWVkZDMx",
    "TGlzdFRlbXBsYXRlOjExZWY0NTdkY2ZlNzM3ODBiODc3NTJhODkxMWE3Y2E3", "TGlzdFRlbXBsYXRlOjExZWY0NTdkNzQxZTVjMzBhOTYxMGFlMTMzZjIwNmJj",
    "TGlzdFRlbXBsYXRlOjExZWY0NTdjNTAxNmZkYzBhNDYzMzIwY2M3YTNmYzli", "TGlzdFRlbXBsYXRlOjExZWY0NTZhYzlhY2NlMTA4MjI1OWU1NDkzNTM1NDY0",
    "TGlzdFRlbXBsYXRlOjExZWU0NWQ5YmE5YjhjNDA5NTIzZmEwNzEwNDM3NGE4", "TGlzdFRlbXBsYXRlOjExZWU0NWRiYzFiY2UzMDA5YjZiNGViYWFhNDIzYTk4",
    "TGlzdFRlbXBsYXRlOjExZWU3OTg2NzUyMzcyYTBiMWE5NzIwZjBkZmQ1Mzky", "TGlzdFRlbXBsYXRlOjExZWVhNzkzM2UyYjcyZDA4OTllNWUwYzNhZDZkNGZj",
    "TGlzdFRlbXBsYXRlOjExZWY5ZDk3M2FkYjU1NTBiMTM2MGU2YmFkZWIyZTRm", "TGlzdFRlbXBsYXRlOjExZWU3OThhMTk1OWIwMjA4NDYwNDI0YmZkOTk5ZTNm",
    "TGlzdFRlbXBsYXRlOjExZWU3OTg3OGU3NjU2OTA4MTVlNWEwZWJiMWMwMDUw", "TGlzdFRlbXBsYXRlOjExZWU3OTgzOTVjNzdlYTBhMmE0NWE5NzI3NjE2MmRl",
    "TGlzdFRlbXBsYXRlOjExZWU0NWUzNjNkNmFjNTA4OGI3MGFkMjg4YjI0NjM0", "TGlzdFRlbXBsYXRlOjExZWU0NWUzM2QyZmY1NzA4OGI3MGFkMjg4YjI0NjM0",
    "TGlzdFRlbXBsYXRlOjExZWU0NWRlYTlhNDA4ZTA4OGI3MGFkMjg4YjI0NjM0"
];
const SENSOR_TEMPLATE_IDS = [
    "TGlzdFRlbXBsYXRlOjExZWU0NWRhNGVlNWUzYTA4NzJlY2FkYzAwMTg1MmVl",
    "TGlzdFRlbXBsYXRlOjExZWYxYjdjNWU4ZDdjMDBiYTI5Y2E4NjI0MDgwZDE4"
];

let probeGridDataCache_v2 = [];
function getLocalTodayStr() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
// --- CASCADING FILTER LOGIC ---
// FIXED: Added 'retryCount = 0' parameter to define the variable
// FIXED: Robust Local Date Handling
function initProbeFilters_v2(retryCount = 0) {
    
    // 1. Wait for locations to load (Retry Logic)
    if (locationsCache.length === 0) {
        if (retryCount < 10) {
            setTimeout(() => initProbeFilters_v2(retryCount + 1), 500);
        } else {
            console.warn("Probe Filters: Locations failed to load.");
        }
        return;
    }

    // 2. Force Local Date (The 'en-CA' locale always outputs YYYY-MM-DD)
    // This is the most reliable way to get "My Computer's Date"
    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA'); 

    console.log("Setting Probe Date to Local Time:", todayStr); // Check console if this is wrong

    const startEl = document.getElementById('probeStartDate');
    const endEl = document.getElementById('probeEndDate');
    
    // Only set if empty (prevents overwriting if you change tabs)
    if (startEl && !startEl.value) startEl.value = todayStr;
    if (endEl && !endEl.value) endEl.value = todayStr;

    // 3. Populate Filters
    const marketSel = document.getElementById('probeMarketFilter_v2');
    const districtSel = document.getElementById('probeDistrictFilter_v2');
    const locationSel = document.getElementById('probeLocationFilter_v2');

    if (!marketSel || !districtSel || !locationSel) return;

    let availableMarkets = new Set();
    let availableDistricts = new Set();

    locationsCache.forEach(loc => {
        const meta = (typeof getMetaForLoc === 'function') ? getMetaForLoc(loc) : null;
        if (meta) {
            if (meta.market) availableMarkets.add(meta.market.trim());
            if (meta.district) availableDistricts.add(meta.district.trim());
        }
    });

    const fill = (sel, items, label) => {
        sel.innerHTML = `<option value="">${label}</option>`;
        Array.from(items).sort().forEach(i => {
            const opt = document.createElement('option');
            opt.value = i; opt.textContent = i; sel.appendChild(opt);
        });
    };

    fill(marketSel, availableMarkets, "All Markets");
    fill(districtSel, availableDistricts, "All Districts");
    
    // Fill Locations
    locationSel.innerHTML = '<option value="">All Locations</option>';
    locationsCache.sort((a,b) => a.name.localeCompare(b.name)).forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id; opt.textContent = loc.name; locationSel.appendChild(opt);
    });
}

function updateProbeFilters_v2(changedType) {
    const marketSel = document.getElementById('probeMarketFilter_v2');
    const districtSel = document.getElementById('probeDistrictFilter_v2');
    const locationSel = document.getElementById('probeLocationFilter_v2');
    
    const meta = storeMetadataCache || [];
    const allLocs = locationsCache || [];

    const selectedMarket = marketSel.value;
    const selectedDistrict = districtSel.value;

    if (changedType === 'market') {
        districtSel.innerHTML = '<option value="">All Districts</option>';
        let relevantMeta = meta;
        if (selectedMarket) relevantMeta = meta.filter(m => m.market === selectedMarket);
        const districts = [...new Set(relevantMeta.map(i => i.district).filter(Boolean))].sort();
        
        districts.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d; opt.textContent = d; districtSel.appendChild(opt);
        });
        districtSel.value = ""; 
    }

    locationSel.innerHTML = '<option value="">All Locations</option>';
    let validMeta = meta;
    if (selectedMarket) validMeta = validMeta.filter(m => m.market === selectedMarket);
    if (districtSel.value) validMeta = validMeta.filter(m => m.district === districtSel.value);

    const validLocations = allLocs.filter(loc => {
        const locNameLower = loc.name.toLowerCase();
        if (validMeta.length === 0 && meta.length === 0) return true;
        return validMeta.some(m => {
            if (m.site && m.site.length > 2 && locNameLower.includes(m.site)) return true;
            if (m.store && locNameLower.includes(m.store.toLowerCase())) return true;
            return false;
        });
    });

    validLocations.sort((a,b) => a.name.localeCompare(b.name));
    validLocations.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id; opt.textContent = loc.name; locationSel.appendChild(opt);
    });
}

// --- GRID LOADING LOGIC ---
async function loadProbeGrid_v2() {
    const startDateStr = document.getElementById('probeStartDate_v2').value;
    const endDateStr = document.getElementById('probeEndDate_v2').value;
    const selLocationId = document.getElementById('probeLocationFilter_v2').value;
    const selDistrict = document.getElementById('probeDistrictFilter_v2').value;
    const selMarket = document.getElementById('probeMarketFilter_v2').value;
    const isGrouped = document.getElementById('probeGroupToggle_v2').checked;

    if (!startDateStr || !endDateStr) { alert("Please select start and end dates."); return; }

    const overlay = document.getElementById('loadingOverlay');
    const loadText = document.getElementById('loadingText');
    overlay.style.display = 'flex';
    probeGridDataCache_v2 = [];

    const startTs = Math.floor(new Date(startDateStr + 'T00:00:00').getTime() / 1000);
    const endTs = Math.floor(new Date(endDateStr + 'T23:59:59').getTime() / 1000);
    
    const tbody = document.querySelector('#probeTable tbody');
    tbody.innerHTML = '';

    // Print Header
    let header = document.getElementById('probePrintHeader');
    if (!header) {
        header = document.createElement('div');
        header.id = 'probePrintHeader';
        header.className = 'only-print';
        const table = document.querySelector('#probeTable');
        table.parentNode.insertBefore(header, table);
    }
    header.innerHTML = `<h2>Probe & Sensor Report</h2><p>Range: ${startDateStr} to ${endDateStr}</p>`;

    let targets = [];
    const allLocs = locationsCache || [];
    const meta = storeMetadataCache || [];

    // Filter Logic
    if (selLocationId) {
        targets = allLocs.filter(l => l.id === selLocationId);
    } else {
        let validMeta = meta;
        if (selMarket) validMeta = validMeta.filter(m => m.market === selMarket);
        if (selDistrict) validMeta = validMeta.filter(m => m.district === selDistrict);

        if (!selMarket && !selDistrict) {
            targets = allLocs;
        } else {
            targets = allLocs.filter(loc => {
                const locName = loc.name.toLowerCase();
                if (validMeta.length === 0 && meta.length === 0) return true;
                return validMeta.some(m => {
                    if (m.site && m.site.length > 2 && locName.includes(m.site)) return true;
                    if (m.store && locName.includes(m.store.toLowerCase())) return true;
                    return false;
                });
            });
        }
    }

    if(targets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:30px;">No stores match the current filters.</td></tr>';
        overlay.style.display = 'none';
        return;
    }

    // --- PREPARE DATA FOR GROUPING ---
    let processedTargets = targets.map(loc => {
        const locName = loc.name.toLowerCase();
        // Loose match logic (same as filters)
        const m = meta.find(item => {
            if (item.site && item.site.length > 2 && locName.includes(item.site)) return true;
            if (item.store && locName.includes(item.store.toLowerCase())) return true;
            return false;
        });
        return {
            ...loc,
            marketName: m ? m.market : 'Unassigned',
            districtName: m ? m.district : 'Unassigned'
        };
    });

    // --- STRICT SORTING ---
    if (isGrouped) {
        processedTargets.sort((a, b) => {
            if (a.marketName !== b.marketName) return a.marketName.localeCompare(b.marketName);
            if (a.districtName !== b.districtName) return a.districtName.localeCompare(b.districtName);
            return a.name.localeCompare(b.name);
        });
    } else {
        processedTargets.sort((a, b) => a.name.localeCompare(b.name));
    }

    // --- LOOP & RENDER (Strict Order Fix) ---
    // We now fetch in chunks, but RENDER synchronously afterwards to prevent race conditions
    const chunkSize = 3; 
    let lastMarket = null;
    let lastDistrict = null;

    for (let i = 0; i < processedTargets.length; i += chunkSize) {
        const chunk = processedTargets.slice(i, i + chunkSize);
        loadText.innerText = `Processing ${i + 1} - ${Math.min(i + chunkSize, processedTargets.length)} of ${processedTargets.length}`;

        // 1. FETCH DATA (Parallel)
        const chunkResults = await Promise.all(chunk.map(async (loc) => {
            try {
                const probeData = await fetchProbeStats_v2(loc.id, startTs, endTs, PROBE_TEMPLATE_IDS);
                const sensorData = await fetchProbeStats_v2(loc.id, startTs, endTs, SENSOR_TEMPLATE_IDS);
                return {
                    loc: loc,
                    probe: probeData || { probePercent: 0, probeCount: 0, probeTotal: 0 },
                    sensor: sensorData || { probePercent: 0, probeCount: 0, probeTotal: 0 },
                    error: null
                };
            } catch(e) {
                return { loc: loc, error: e };
            }
        }));

        // 2. RENDER DATA (Synchronous & Sorted)
        // We iterate the results in the same order they were in 'chunk' (which is sorted)
        for (const res of chunkResults) {
            // Header Logic
            if (isGrouped) {
                if (res.loc.marketName !== lastMarket || res.loc.districtName !== lastDistrict) {
                    const headerRow = document.createElement('tr');
                    headerRow.style.background = '#e2e8f0'; 
                    headerRow.innerHTML = `<td colspan="3" style="font-weight:bold; color:#1e293b; padding:10px 12px; border-top:2px solid #94a3b8;">${res.loc.marketName} <span style="color:#64748b; font-weight:normal; margin:0 5px;">/</span> ${res.loc.districtName}</td>`;
                    tbody.appendChild(headerRow);
                    lastMarket = res.loc.marketName;
                    lastDistrict = res.loc.districtName;
                }
            }

            // Row Logic
            if (res.error) {
                console.error("Probe Grid Error " + res.loc.name, res.error);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td><strong>${res.loc.name}</strong></td><td colspan="2" style="color:red;">Error loading data</td>`;
                tbody.appendChild(tr);
            } else {
                const rowData = {
                    name: res.loc.name,
                    probe: res.probe,
                    sensor: res.sensor
                };
                probeGridDataCache_v2.push(rowData);
                renderProbeRow_v2(tbody, rowData);
            }
        }
        
        // Small delay between chunks to be nice to API
        await delay(300); 
    }
    overlay.style.display = 'none';
}

async function fetchProbeStats_v2(locationId, start, end, templateIds) {
    const query = `query ProbeUsage($mode: ModeInput!, $filter: ProbeUsageTimeSeriesFilter!) { probeUsageTimeSeries(mode: $mode, filter: $filter) { probeCount probeTotal probePercent } }`;
    const variables = {
        mode: { mode: "CONTENT_GROUP", id: PROBE_CONTENT_GROUP_ID },
        filter: { listTemplateIds: templateIds, displayAfterTimestamp: start, displayBeforeTimestamp: end, locationIds: [locationId] }
    };
    try {
        const data = await joltFetch(query, variables);
        const series = data.data?.probeUsageTimeSeries;
        return (series && series.length > 0) ? series[0] : null;
    } catch(e) { return null; }
}

function renderProbeRow_v2(tbody, data) {
    const tr = document.createElement('tr');
    const renderCell = (stats) => {
        if (!stats || stats.probeTotal === 0) return `<span class="list-status ls-missing">N/A</span>`;
        const pct = stats.probePercent;
        let color = "#166534"; let bg = "#dcfce7";
        if (pct < 100) { color = "#991b1b"; bg = "#fee2e2"; }
        return `<div style="display:flex; flex-direction:column;"><span style="background:${bg}; color:${color}; padding:4px 8px; border-radius:12px; font-weight:bold; display:inline-block; width:fit-content;">${pct}%</span><span style="font-size:0.75rem; color:#666; margin-top:2px;">(${stats.probeCount}/${stats.probeTotal})</span></div>`;
    };
    tr.innerHTML = `<td><strong>${data.name}</strong></td><td>${renderCell(data.probe)}</td><td>${renderCell(data.sensor)}</td>`;
    tbody.appendChild(tr);
}

function exportProbeGridCSV_v2() {
    if (!probeGridDataCache_v2 || probeGridDataCache_v2.length === 0) { alert("No data to export."); return; }
    let csv = "Store Name,Probe %,Probe Count,Probe Total,Sensor %,Sensor Count,Sensor Total\n";
    probeGridDataCache_v2.forEach(d => { csv += `"${d.name}","${d.probe.probePercent}","${d.probe.probeCount}","${d.probe.probeTotal}","${d.sensor.probePercent}","${d.sensor.probeCount}","${d.sensor.probeTotal}"\n`; });
    downloadCSV(csv, "jolt_probe_sensor_report.csv");
}

// Auto-Init Listener
window.addEventListener('DOMContentLoaded', () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const pStart = document.getElementById('probeStartDate_v2');
    const pEnd = document.getElementById('probeEndDate_v2');
    if(pStart) pStart.value = todayStr;
    if(pEnd) pEnd.value = todayStr;
    initProbeFilters_v2();
});
/* --- END PROBE LOGIC (V4) --- */
// --- SAFETY GRID FILTER LOGIC (Cascading) ---
// --- SAFETY GRID FILTER LOGIC (Robust) ---
function updateSafetyFilters(source) {
    const marketSel = document.getElementById('safetyMarketFilter');
    const districtSel = document.getElementById('safetyDistrictFilter');
    const locationSel = document.getElementById('safetyLocationFilter');

    if (!marketSel || !districtSel || !locationSel) return;

    const selectedMarket = marketSel.value.trim();
    const selectedDistrict = districtSel.value.trim();

    let availableLocs = locationsCache;

    // Filter by Market
    if (selectedMarket) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.market.trim() === selectedMarket;
        });
    }

    // Filter by District
    if (source === 'district' && selectedDistrict) {
        availableLocs = availableLocs.filter(loc => {
            const meta = getMetaForLoc(loc);
            return meta && meta.district.trim() === selectedDistrict;
        });
    }

    // Update District Dropdown
    if (source === 'market' || source === 'init') {
        const uniqueDistricts = new Set();
        availableLocs.forEach(loc => {
            const meta = getMetaForLoc(loc);
            if (meta && meta.district) uniqueDistricts.add(meta.district.trim());
        });
        
        const oldDist = districtSel.value;
        
        districtSel.innerHTML = '<option value="">All Districts</option>';
        Array.from(uniqueDistricts).sort().forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            districtSel.appendChild(opt);
        });
        
        if (source === 'init' && oldDist && uniqueDistricts.has(oldDist)) {
             districtSel.value = oldDist;
        } else {
            districtSel.value = "";
        }
    }

    // Update Location Dropdown
    locationSel.innerHTML = '<option value="">All Locations</option>';
    availableLocs.sort((a,b) => a.name.localeCompare(b.name));
    
    availableLocs.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc.id;
        opt.textContent = loc.name;
        locationSel.appendChild(opt);
    });
}