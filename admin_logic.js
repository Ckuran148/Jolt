// --- ADMIN & USER MANAGEMENT LOGIC ---

// 1. CHANGE MY PASSWORD (User changes their own)
async function changeMyPassword() {
    const newPass = document.getElementById('newPassword').value;
    if (newPass.length < 6) { alert("Password must be at least 6 characters."); return; }

    try {
        const user = firebase.auth().currentUser;
        await user.updatePassword(newPass);
        
        // Remove the "must change" flag if it exists
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
        // Hide the cancel button to force the change
        document.querySelector('#settingsModal .btn-secondary').style.display = 'none';
    }
}

// 3. LOAD USERS FOR ADMIN PANEL
async function loadAdminPanel() {
    if (window.userProfile.role !== 'admin') return;

    const tbody = document.querySelector('#adminUserTable tbody');
    if(tbody) tbody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
    
    try {
        const snapshot = await db.collection('users').get();
        if(tbody) tbody.innerHTML = '';

        snapshot.forEach(doc => {
            const u = doc.data();
            const tr = document.createElement('tr');
            
            const userRole = u.role || 'market';
            const userScope = u.scope || '';

            tr.innerHTML = `
                <td>${u.email}</td>
                <td>
                    <select onchange="updateUser('${u.email}', 'role', this.value)">
                        <option value="store" ${userRole==='store'?'selected':''}>Store / Site</option>
                        <option value="market" ${userRole==='market'?'selected':''}>Market</option>
                        <option value="district" ${userRole==='district'?'selected':''}>District</option>
                        <option value="admin" ${userRole==='admin'?'selected':''}>Admin</option>
                    </select>
                </td>
                <td>
                    <input type="text" value="${userScope}" onblur="updateUser('${u.email}', 'scope', this.value)" style="padding:4px; width:100%;">
                </td>
                <td style="display:flex; flex-direction:column; gap:5px;">
                    <div style="display:flex; gap:5px;">
                         <button class="btn-secondary" style="font-size:0.7rem; color:blue; flex:1;" onclick="sendResetEmail('${u.email}')">📧 Reset</button>
                         <button class="btn-secondary" style="font-size:0.7rem; color:red; flex:1;" onclick="resetUserPassFlag('${u.email}')">🔓 Unstuck</button>
                    </div>
                    <button class="btn-secondary" style="font-size:0.7rem; background:#fee2e2; color:#b91c1c; border:1px solid #b91c1c;" onclick="deleteUser('${u.email}')">❌ Delete User</button>
                </td>
            `;
            if(tbody) tbody.appendChild(tr);
        });
    } catch (e) {
        console.error("Error loading admin panel:", e);
        if(tbody) tbody.innerHTML = `<tr><td colspan="4" style="color:red;">Error: ${e.message}</td></tr>`;
    }
}

// 4. HELPER ACTIONS
async function updateUser(docId, field, val) {
    try {
        await db.collection('users').doc(docId).update({ [field]: val });
    } catch(e) { alert("Error updating user: " + e.message); }
}

async function sendResetEmail(email) {
    if(!confirm(`Send a password reset email to ${email}?`)) return;
    try {
        await firebase.auth().sendPasswordResetEmail(email);
        alert("✅ Reset email sent! Tell the user to check their inbox (and spam).");
    } catch(e) {
        alert("Error sending email: " + e.message);
    }
}

async function resetUserPassFlag(email) {
    if(confirm(`Reset 'Force Password Change' flag for ${email}? (Use this if they are stuck in a loop)`)) {
        await db.collection('users').doc(email).update({ mustChangePassword: false });
        alert("Flag reset.");
    }
}

// 5. CREATE NEW USER
async function createNewUser() {
    // TRIM INPUTS TO REMOVE ACCIDENTAL SPACES
    const email = document.getElementById('newUserEmail').value.trim();
    const tempPass = document.getElementById('newUserTempPass').value.trim();
    const role = document.getElementById('newUserRole').value;
    const scope = document.getElementById('newUserScope').value.trim();
    const forceReset = document.getElementById('newUserForceReset').checked;

    if(!email || !scope || !tempPass) { alert("Please fill all fields."); return; }

    const btn = document.querySelector('#addUserModal .btn-primary');
    btn.disabled = true; btn.innerText = "Creating...";

    try {
        // A. Create Authentication (Secondary App Trick)
        const secondaryApp = firebase.initializeApp(firebaseConfig, "SecondaryApp");
        await secondaryApp.auth().createUserWithEmailAndPassword(email, tempPass);
        await secondaryApp.auth().signOut();
        await secondaryApp.delete();

        // B. Create Database Record
        await db.collection('users').doc(email).set({
            email: email,
            role: role,
            scope: scope,
            mustChangePassword: forceReset
        });

        alert(`✅ User Created Successfully!\n\nEmail: [${email}]\nPassword: [${tempPass}]\n\n(Spaces were removed automatically)`);
        document.getElementById('addUserModal').style.display = 'none';
        loadAdminPanel(); 

    } catch (e) {
        if(e.code === 'auth/email-already-in-use') {
             alert("Error: This email is already registered. You cannot create it again.");
        } else {
             alert("Error: " + e.message);
        }
    }
    btn.disabled = false; btn.innerText = "Create User";
}
// 7. DELETE USER (Revoke Access)
async function deleteUser(email) {
    // Prevent deleting yourself
    if (email === firebase.auth().currentUser.email) {
        alert("You cannot delete your own admin account while logged in.");
        return;
    }

    const confirmMsg = `Are you sure you want to delete ${email}?\n\nThey will immediately lose access to the dashboard.\n(Note: To reuse this email later, you must also delete them in the Firebase Console > Authentication tab)`;
    
    if (confirm(confirmMsg)) {
        try {
            // Delete the Firestore document (Removes Permissions)
            await db.collection('users').doc(email).delete();
            
            alert(`User ${email} deleted. They can no longer access the app.`);
            loadAdminPanel(); // Refresh table
        } catch (e) {
            alert("Error deleting user: " + e.message);
        }
    }
}