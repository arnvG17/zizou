"use client";

import React, { createContext, useContext, useState, useEffect } from "react";

interface ThemeContextProps {
  isDarkMode: boolean;
  setIsDarkMode: (val: boolean) => void;
  hasScanlines: boolean;
  setHasScanlines: (val: boolean) => void;
}

const ThemeContext = createContext<ThemeContextProps>({
  isDarkMode: false,
  setIsDarkMode: () => {},
  hasScanlines: false,
  setHasScanlines: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [hasScanlines, setHasScanlines] = useState(false);

  useEffect(() => {
    const root = window.document.documentElement;
    if (isDarkMode) {
      root.classList.add("dark");
      root.classList.remove("light");
    } else {
      root.classList.add("light");
      root.classList.remove("dark");
    }
  }, [isDarkMode]);

  return (
    <ThemeContext.Provider
      value={{
        isDarkMode,
        setIsDarkMode,
        hasScanlines,
        setHasScanlines,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
