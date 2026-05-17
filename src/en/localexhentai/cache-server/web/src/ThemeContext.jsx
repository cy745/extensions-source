import { createContext, useContext, useEffect, useState } from 'react';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('cs-theme') || 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('cs-theme', theme);
  }, [theme]);

  const cycleTheme = () => {
    setTheme(p => ({ light: 'dark', dark: 'system', system: 'light' })[p]);
  };

  const themeIcon = { light: '☀️', dark: '🌙', system: '🖥' };

  return (
    <ThemeContext.Provider value={{ theme, cycleTheme, themeIcon: themeIcon[theme] }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
