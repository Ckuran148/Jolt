// --- ADMIN & USER MANAGEMENT LOGIC ---

// 1. CHANGE MY PASSWORD
async function changeMyPassword() {
    const newPass = document.getElementById('newPassword').value;
    if (newPass.length < 6) { alert("Password must be at least 6 characters."); return; }

    try {
        const user = firebase.auth().currentUser;
        await user.updatePassword(newPass);
        await db.collection('users').doc(user.email).update({ mustChangePassword: false });
        alert("Password updated! You are now logged in.");
        document.getElementById('settingsModal').style.display = 'none';
    } catch (e) {
        alert("Error: " + e.message);
    }
}

// 2. CHECK FORCE RESET
async function checkPasswordResetRequirement(email) {
    const doc = await db.collection('users').doc(email).get();
    if (doc.exists && doc.data().mustChangePassword) {
        alert("⚠️ Security Alert: You must change your password before continuing.");
        document.getElementById('settingsModal').style.display = 'flex';
        document.querySelector('#settingsModal .btn-secondary').style.display = 'none';
    }
}

// 3. LOAD USERS FOR ADMIN PANEL
async function loadAdminPanel() {
    if (window.userProfile.role !== 'admin') return;

    const tbody = document.querySelector('#adminUserTable tbody');
    if(tbody) tbody.innerHTML = '<tr><td colspan="5">Loading users...</td></tr>';
    
    try {
        const snapshot = await db.collection('users').get();
        if(tbody) tbody.innerHTML = '';

        snapshot.forEach(doc => {
            const u = doc.data();
            const tr = document.createElement('tr');
            
            let scopeDisplay = u.scope || "No Access";
            if (u.role === 'admin') scopeDisplay = "Global Admin";
            else if (scopeDisplay.length > 50) scopeDisplay = scopeDisplay.substring(0, 50) + "...";

            // ADDED NAME COLUMN
            tr.innerHTML = `
                <td>${u.name || '-'}</td>
                <td>${u.email}</td>
                <td>${u.role ? u.role.toUpperCase() : 'UNKNOWN'}</td>
                <td title="${u.scope}">${scopeDisplay}</td>
                <td>
                    <button class="btn-primary" style="padding:4px 8px; font-size:0.8rem;" onclick="openEditUserModal('${u.email}')">✏️ Edit</button>
                    <button class="btn-secondary" style="padding:4px 8px; font-size:0.8rem; color:#b91c1c;" onclick="deleteUser('${u.email}')">🗑️</button>
                </td>
            `;
            if(tbody) tbody.appendChild(tr);
        });
    } catch (e) {
        if(tbody) tbody.innerHTML = `<tr><td colspan="5" style="color:red;">Error: ${e.message}</td></tr>`;
    }
}

// 4. OPEN CREATE USER MODAL (Updated)
function openCreateUserModal() {
    // Clear inputs
    document.getElementById('newUserName').value = ""; // NEW
    document.getElementById('newUserEmail').value = "";
    document.getElementById('newUserTempPass').value = "Wendy2025!";
    document.getElementById('newUserRole').value = "store";
    
    populateCheckboxes('listNewMarkets', getUniqueMeta('market'), [], "syncSitesFromParent(this, 'market')");
    populateCheckboxes('listNewDistricts', getUniqueMeta('district'), [], "syncSitesFromParent(this, 'district')");
    
    const siteContainer = document.getElementById('listNewSites');
    siteContainer.innerHTML = '';
    const allSites = locationsCache ? [...locationsCache].sort((a,b) => a.name.localeCompare(b.name)) : [];

    allSites.forEach(loc => {
        const div = document.createElement('div');
        div.className = 'checkbox-item';
        div.innerHTML = `<input type="checkbox" value="${loc.name}"><span>${loc.name}</span>`;
        siteContainer.appendChild(div);
    });

    toggleNewUserScopeSections();
    document.getElementById('addUserModal').style.display = 'flex';
}

// 5. SYNC LOGIC
function syncSitesFromParent(checkbox, type) {
    const parentName = checkbox.value;
    const isChecked = checkbox.checked;
    
    const targetSites = locationsCache.filter(loc => {
        const meta = (typeof getMetaForLoc === 'function') ? getMetaForLoc(loc) : null;
        if (!meta) return false;
        if (type === 'market') return meta.market === parentName;
        if (type === 'district') return meta.district === parentName;
        return false;
    }).map(l => l.name);
    
    const siteContainer = document.getElementById('listNewSites');
    const siteBoxes = siteContainer.querySelectorAll('input[type="checkbox"]');
    
    siteBoxes.forEach(box => {
        if (targetSites.includes(box.value)) {
            box.checked = isChecked;
        }
    });
}

// 6. TOGGLE NEW USER SECTIONS
function toggleNewUserScopeSections() {
    const role = document.getElementById('newUserRole').value;
    document.getElementById('section-new-market').style.display = 'none';
    document.getElementById('section-new-district').style.display = 'none';
    document.getElementById('section-new-site').style.display = 'block';

    if (role === 'market') {
        document.getElementById('section-new-market').style.display = 'block';
    } else if (role === 'district') {
        document.getElementById('section-new-district').style.display = 'block';
    }
}

// 7. OPEN EDIT MODAL
let editingUserEmail = null;

async function openEditUserModal(email) {
    editingUserEmail = email;
    document.getElementById('editUserEmailDisplay').innerText = email;
    
    const doc = await db.collection('users').doc(email).get();
    if (!doc.exists) return;
    const userData = doc.data();

    // LOAD NAME
    document.getElementById('editUserName').value = userData.name || ""; // NEW
    document.getElementById('editUserRole').value = userData.role || 'store';
    
    const currentScopes = (userData.scope || "").split(',').map(s => s.trim());
    const container = document.getElementById('listSites');
    container.innerHTML = '';
    
    const allSites = locationsCache ? [...locationsCache].sort((a,b) => a.name.localeCompare(b.name)) : [];

    allSites.forEach(loc => {
        let isChecked = false;
        if (currentScopes.includes(loc.name)) {
            isChecked = true;
        } else if (typeof getMetaForLoc === 'function') {
            const meta = getMetaForLoc(loc);
            if (meta) {
                if (userData.role === 'market' && currentScopes.includes(meta.market)) isChecked = true;
                if (userData.role === 'district' && currentScopes.includes(meta.district)) isChecked = true;
                if (userData.role === 'admin') isChecked = true; 
            }
        }
        const div = document.createElement('div');
        div.className = 'checkbox-item';
        div.innerHTML = `<input type="checkbox" value="${loc.name}" ${isChecked ? 'checked' : ''}><span>${loc.name}</span>`;
        container.appendChild(div);
    });

    toggleScopeSections();
    document.getElementById('editUserModal').style.display = 'flex';
}

function toggleScopeSections() {
    document.getElementById('section-market').style.display = 'none';
    document.getElementById('section-district').style.display = 'none';
    document.getElementById('section-site').style.display = 'block';
}

function filterCheckboxList(listId, text) {
    const container = document.getElementById(listId);
    const items = container.getElementsByClassName('checkbox-item');
    const filter = text.toLowerCase();
    for (let i = 0; i < items.length; i++) {
        const label = items[i].innerText.toLowerCase();
        items[i].style.display = label.includes(filter) ? "flex" : "none";
    }
}

// 8. SAVE EDIT CHANGES (Updated)
async function saveUserChanges() {
    if (!editingUserEmail) return;
    
    const name = document.getElementById('editUserName').value.trim(); // NEW
    const role = document.getElementById('editUserRole').value;
    const selectedSites = getCheckedValues('listSites');

    let scopeString = "";
    if (role === 'admin' && selectedSites.length === 0) {
        scopeString = "ALL";
    } else {
        scopeString = selectedSites.join(', ');
    }

    try {
        await db.collection('users').doc(editingUserEmail).update({
            name: name, // SAVE NAME
            role: role,
            scope: scopeString
        });
        
        alert("User Permissions Updated!");
        document.getElementById('editUserModal').style.display = 'none';
        loadAdminPanel(); 
    } catch(e) {
        alert("Error saving: " + e.message);
    }
}

// 9. CREATE NEW USER (Updated)
async function createNewUser() {
    const name = document.getElementById('newUserName').value.trim(); // NEW
    const email = document.getElementById('newUserEmail').value.trim();
    const tempPass = document.getElementById('newUserTempPass').value.trim();
    const role = document.getElementById('newUserRole').value;
    const forceReset = document.getElementById('newUserForceReset').checked;
    
    const selectedSites = getCheckedValues('listNewSites');
    let scopeString = "";
    if (role === 'admin' && selectedSites.length === 0) scopeString = "ALL";
    else scopeString = selectedSites.join(', ');

    if(!email || !tempPass) { alert("Please enter an email and password."); return; }
    if(role !== 'admin' && !scopeString) { alert("Please select at least one site."); return; }

    const btn = document.querySelector('#addUserModal .btn-primary');
    btn.disabled = true; btn.innerText = "Creating...";

    try {
        const secondaryApp = firebase.initializeApp(firebaseConfig, "SecondaryApp");
        await secondaryApp.auth().createUserWithEmailAndPassword(email, tempPass);
        await secondaryApp.auth().signOut();
        await secondaryApp.delete();

        await db.collection('users').doc(email).set({
            name: name, // SAVE NAME
            email: email, role: role, scope: scopeString, mustChangePassword: forceReset
        });

        alert(`✅ User Created Successfully!`);
        document.getElementById('addUserModal').style.display = 'none';
        loadAdminPanel(); 

    } catch (e) {
        alert("Error: " + e.message);
    }
    btn.disabled = false; btn.innerText = "Create User";
}

// Helpers
function getUniqueMeta(field) {
    if (!storeMetadataCache) return []; 
    return [...new Set(storeMetadataCache.map(i => i[field]).filter(Boolean))].sort();
}

function populateCheckboxes(containerId, items, selectedItems, onChangeStr = "") {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    items.forEach(item => {
        const isChecked = selectedItems.includes(item);
        const div = document.createElement('div');
        div.className = 'checkbox-item';
        const changeAttr = onChangeStr ? `onchange="${onChangeStr}"` : '';
        div.innerHTML = `<input type="checkbox" value="${item}" ${isChecked ? 'checked' : ''} ${changeAttr}><span>${item}</span>`;
        container.appendChild(div);
    });
}

function getCheckedValues(containerId) {
    const container = document.getElementById(containerId);
    const checked = container.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checked).map(cb => cb.value);
}

// 10. DELETE USER
async function deleteUser(email) {
    if (email === firebase.auth().currentUser.email) { alert("Cannot delete your own account."); return; }
    if (confirm(`Delete ${email}? They will lose access immediately.`)) {
        try {
            await db.collection('users').doc(email).delete();
            alert(`User ${email} deleted.`);
            loadAdminPanel();
        } catch (e) { alert("Error: " + e.message); }
    }
}