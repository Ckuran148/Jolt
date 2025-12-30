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
async function loadProfileAndStart(email) {
    try {
        // A. Get Role from Firestore
        const docRef = db.collection('users').where('email', '==', email);
        const snapshot = await docRef.get();

        if (snapshot.empty) {
            alert("Login failed: User has no assigned role in database.");
            await auth.signOut(); // Force logout so they can try again
            return;
        }

        // B. Save Profile
        const data = snapshot.docs[0].data();
        window.userProfile.role = data.role;   // 'market', 'district', 'admin', OR 'store'
        window.userProfile.scope = data.scope; // e.g. 'South 48'
        
        console.log("Profile Loaded:", window.userProfile);

        // C. Hide Overlay
        const overlay = document.getElementById('loginOverlay');
        if(overlay) overlay.style.display = 'none';

        // D. Show Admin Tab (if applicable)
        if (window.userProfile.role === 'admin') {
            const adminNav = document.getElementById('nav-admin-section');
            if (adminNav) adminNav.style.display = 'block';
        }

        // E. Check Force Reset
        if (typeof checkPasswordResetRequirement === 'function') {
            checkPasswordResetRequirement(email);
        }

        // F. Start Jolt App (Prevent double-loading)
        if (!window.appLoaded && typeof loadStoreMetadata === "function") {
            window.appLoaded = true; // Flag to prevent double load
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