import { Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './ThemeContext';
import Dashboard from './pages/Dashboard';
import GalleryOverview from './pages/GalleryOverview';
import GalleryDetail from './pages/GalleryDetail';
import RandomPreview from './pages/RandomPreview';
import './App.css';

export default function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/gallery" element={<GalleryOverview />} />
        <Route path="/gallery/random/:seed" element={<RandomPreview />} />
        <Route path="/gallery/:gid" element={<GalleryDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ThemeProvider>
  );
}
