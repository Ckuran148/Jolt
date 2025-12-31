const firebaseConfig = {
  apiKey: "AIzaSyBvZkTbBkIl4ECIE0HpyxCfGxP67dcvkCw",
  authDomain: "jolt-dash.firebaseapp.com",
  projectId: "jolt-dash",
  storageBucket: "jolt-dash.firebasestorage.app",
  messagingSenderId: "976413270432",
  appId: "1:976413270432:web:7a170fcaa680ff854244c5"
};
// 2. INITIALIZE FIREBASE
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.firestore();

// Global State
window.userProfile = { role: null, scope: null };

// 2. SESSION LISTENER (The Fix for Refresh)
// This runs automatically when the page loads
auth.onAuthStateChanged(async (user) => {
    if (user) {
        console.log("Session restored for:", user.email);
        // User is logged in, let's load their profile and start the app
        await loadProfileAndStart(user.email);
    } else {
        console.log("No active session.");
        // Ensure overlay is visible if no user
        document.getElementById('loginOverlay').style.display = 'flex';
    }
});

// 3. LOGIN BUTTON HANDLER
async function handleLogin() {
    const email = document.getElementById('txtEmail').value;
    const pass = document.getElementById('txtPassword').value;
    const errorMsg = document.getElementById('loginError');
    const btn = document.querySelector('#loginOverlay button');

    if (!email || !pass) { errorMsg.innerText = "Please enter email and password."; return; }

    try {
        errorMsg.innerText = "";
        btn.innerText = "Signing in...";
        btn.disabled = true;

        const userCred = await auth.signInWithEmailAndPassword(email, pass);
        // The onAuthStateChanged listener above will catch this and run loadProfileAndStart automatically!
        
    } catch (error) {
        console.error("Login Error:", error);
        errorMsg.innerText = error.message;
        btn.innerText = "Sign In";
        btn.disabled = false;
    }
}

// 4. SHARED STARTUP LOGIC
// A. LOAD USER PROFILE & START APP
async function loadProfileAndStart(email) {
    try {
        const doc = await db.collection('users').doc(email).get();
        if (!doc.exists) {
            // Force logout if user deleted from DB but still in Auth
            await auth.signOut();
            alert("Account not found. Please contact admin.");
            return;
        }

        const data = doc.data();
        window.userProfile.role = data.role;
        window.userProfile.scope = data.scope;
        
        // --- NEW: DISPLAY NAME IN SIDEBAR ---
        const fullName = data.name || "User";
        const firstName = fullName.split(' ')[0]; // Get just the first name
        const displayEl = document.getElementById('sidebarUserDisplay');
        if(displayEl) {
            displayEl.innerHTML = `Welcome, <strong>${firstName}</strong>`;
        }
        // ------------------------------------

        console.log("Profile Loaded:", window.userProfile);

        // Hide Overlay
        const overlay = document.getElementById('loginOverlay');
        if(overlay) overlay.style.display = 'none';

        // Show Admin Tab if applicable
        if (window.userProfile.role === 'admin') {
            const adminNav = document.getElementById('nav-admin-section');
            if (adminNav) adminNav.style.display = 'block';
        }

        // Check Force Reset
        if (typeof checkPasswordResetRequirement === 'function') {
            checkPasswordResetRequirement(email);
        }

        // Start Jolt App
        if (!window.appLoaded && typeof loadStoreMetadata === "function") {
            window.appLoaded = true; 
            loadStoreMetadata().then(() => {
                 fetchLocations(); 
            });
        }

    } catch (e) {
        console.error("Profile Load Error:", e);
        alert("Error loading user profile: " + e.message);
    }
}

async function handleLogout() {
    try {
        await auth.signOut();
        window.location.reload(); // Refresh page to reset all caches & state
    } catch (error) {
        console.error("Logout Error:", error);
        alert("Error logging out: " + error.message);
    }
}