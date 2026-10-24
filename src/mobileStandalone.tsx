/**
 * Entry point for Sara Mobile (standalone).
 *
 * Deliberately does not import the desktop App, the server client, the API
 * modules or the character studio: this bundle is the phone app on its own.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { StandaloneApp } from "./mobile/standalone/StandaloneApp";

const container = document.getElementById("root");
if (!container) throw new Error("Sara Mobile: #root is missing from mobile.html");

createRoot(container).render(
  <StrictMode>
    <StandaloneApp />
  </StrictMode>,
);
