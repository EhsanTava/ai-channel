import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router.js';
import './index.css';
import { TeamAccess } from './components/TeamAccess.js';

const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <TeamAccess><RouterProvider router={router} /></TeamAccess>
  </React.StrictMode>
);
