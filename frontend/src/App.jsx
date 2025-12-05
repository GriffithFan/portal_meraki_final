import { useState, useEffect, useRef } from 'react';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AdminPanel from './pages/AdminPanel';
import ErrorBoundary from './components/ErrorBoundary';

// Root component - handles authentication state and routing
function App() {
  // Technician username/email from login
  const [techUser, setTechUser] = useState(() => localStorage.getItem('sessionUser') || '');
  // JWT token from backend - null if not authenticated
  const [token, setToken] = useState(() => localStorage.getItem('sessionToken') || null);
  // Admin key for privileged operations
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('adminKey') || '');

  // 15 minute idle timeout before auto-logout for security
  const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
  const lastActivityRef = useRef(Number(localStorage.getItem('lastActivity') || Date.now()));
  const idleTimerRef = useRef(null);

  // Persist session state to localStorage for page refresh
  useEffect(() => {
    if (techUser) localStorage.setItem('sessionUser', techUser);
    else localStorage.removeItem('sessionUser');
    if (token) localStorage.setItem('sessionToken', token);
    else localStorage.removeItem('sessionToken');
    if (adminKey) localStorage.setItem('adminKey', adminKey);
    else localStorage.removeItem('adminKey');
  }, [techUser, token, adminKey]);

  // Track user activity and enforce idle timeout
  useEffect(() => {
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
      try { localStorage.setItem('lastActivity', String(lastActivityRef.current)); } catch (e) { console.debug('localStorage write failed', e); }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        // Auto-logout on inactivity for security compliance
        setTechUser('');
        setToken(null);
        lastActivityRef.current = 0;
        try { localStorage.removeItem('lastActivity'); } catch (e) { console.debug('localStorage remove failed', e); }
      }, IDLE_TIMEOUT_MS);
    };

    // Monitor typical user interactions
    const events = ['mousemove', 'keydown', 'touchstart', 'click'];
    events.forEach((ev) => window.addEventListener(ev, updateActivity));

    // Check if session already expired before setting up timers
    const last = Number(localStorage.getItem('lastActivity') || Date.now());
    lastActivityRef.current = last;
    const since = Date.now() - last;
    if (since >= IDLE_TIMEOUT_MS) {
      // Session already expired, logout immediately
      setTechUser(''); setToken(null);
      try { localStorage.removeItem('lastActivity'); } catch (e) { console.debug('localStorage remove failed', e); }
    } else {
      // Schedule logout for remaining time
      idleTimerRef.current = setTimeout(() => {
        setTechUser(''); setToken(null);
        try { localStorage.removeItem('lastActivity'); } catch (e) { console.debug('localStorage remove failed', e); }
      }, IDLE_TIMEOUT_MS - since);
    }

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, updateActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [IDLE_TIMEOUT_MS]);

  const handleLogin = (username, jwtToken = null) => {
    setTechUser(username);
    setToken(jwtToken);
    setAdminKey('');
    // Reset idle timer on successful login
    lastActivityRef.current = Date.now();
    try { localStorage.setItem('lastActivity', String(lastActivityRef.current)); } catch (e) { console.debug('localStorage write failed', e); }
  };

  const handleLogout = () => {
    setTechUser('');
    setToken(null);
    try { localStorage.removeItem('lastActivity'); } catch (e) { console.debug('localStorage remove failed', e); }
  };

  const handleAdminLogin = (key) => {
    setAdminKey(key);
    setTechUser('');
  };

  const handleAdminLogout = () => {
    setAdminKey('');
  };

  if (adminKey) {
    return <AdminPanel adminKey={adminKey} onLogout={handleAdminLogout} />;
  }
  if (techUser) {
    return (
      <ErrorBoundary>
        <Dashboard user={techUser} token={token} onLogout={handleLogout} />
      </ErrorBoundary>
    );
  }

  return <Login onLogin={handleLogin} onAdminLogin={handleAdminLogin} />;
}

export default App;
