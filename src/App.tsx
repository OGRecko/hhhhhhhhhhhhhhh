import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LandingPage from './components/LandingPage';
import { RotateDevicePrompt } from './components/RotateDevicePrompt';

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <RotateDevicePrompt />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/app" element={<Layout />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
