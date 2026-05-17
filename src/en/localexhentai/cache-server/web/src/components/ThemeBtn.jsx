import { useTheme } from '../ThemeContext';

export default function ThemeBtn() {
  const { cycleTheme, themeIcon } = useTheme();
  return (
    <button className="theme-btn" onClick={cycleTheme} title="Toggle theme">
      {themeIcon}
    </button>
  );
}
