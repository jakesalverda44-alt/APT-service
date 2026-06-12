import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { auth } from './api';
import Login from './pages/Login';
import CustomerCenter from './pages/CustomerCenter';
import DispatchBoard from './pages/DispatchBoard';
import Jobs from './pages/Jobs';
import Agreements from './pages/Agreements';
import Intake from './pages/Intake';
import Import from './pages/Import';

function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const user = auth.user;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">
          ACCURATE POWER <span className="bolt">⚡</span> SERVICE
        </span>
        <nav>
          <NavLink to="/customers">Customer Center</NavLink>
          <NavLink to="/board">Dispatch Board</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/agreements">Agreements</NavLink>
          <NavLink to="/intake">Intake</NavLink>
          <NavLink to="/import">Import</NavLink>
        </nav>
        <span className="spacer" />
        <span className="user">{user.name}</span>
        <button
          className="link"
          onClick={() => {
            auth.clear();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </div>
      {children}
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/customers" element={<Shell><CustomerCenter /></Shell>} />
      <Route path="/board" element={<Shell><DispatchBoard /></Shell>} />
      <Route path="/jobs" element={<Shell><Jobs /></Shell>} />
      <Route path="/agreements" element={<Shell><Agreements /></Shell>} />
      <Route path="/intake" element={<Shell><Intake /></Shell>} />
      <Route path="/import" element={<Shell><Import /></Shell>} />
      <Route path="*" element={<Navigate to="/customers" replace />} />
    </Routes>
  );
}
