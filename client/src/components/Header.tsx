import { useState } from "react";
import Logo from "./Logo";
import { Link, useLocation } from "wouter";
import { Menu, X, Home, Camera, Search, Sheet, Settings, LogOut, User as UserIcon } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

const NAV_ITEMS = [
  { label: "Home", href: "/", icon: Home },
  { label: "Scan Cards", href: "/scan", icon: Camera },
  { label: "Manual Lookup", href: "/search", icon: Search },
  { label: "My Sheets", href: "/sheets", icon: Sheet, requiresAuth: true },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useLocation();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    setOpen(false);
    setLocation('/login');
  };

  return (
    <>
      <header className="sticky top-0 z-30 bg-white shadow-sm">
        <div className="flex justify-between items-center px-4 py-4">
          <Link href="/" className="flex items-center space-x-2" onClick={() => setOpen(false)}>
            <Logo className="h-8 w-8" tile />
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink">PackScan</h1>
          </Link>
          <button
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Open menu"}
            className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-20 bg-black/20" onClick={() => setOpen(false)} />
      )}

      <nav
        className={`fixed top-[57px] left-0 right-0 z-20 bg-white shadow-lg border-t border-gray-100 transition-all duration-200 max-w-lg mx-auto ${
          open ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 -translate-y-2 pointer-events-none"
        }`}
      >
        {user && (
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3 bg-gray-50">
            <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
              <UserIcon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user.displayName || user.email}</div>
              {user.email && <div className="text-xs text-gray-500 truncate">{user.email}</div>}
            </div>
          </div>
        )}
        <ul className="py-2">
          {NAV_ITEMS.filter((item) => !item.requiresAuth || user).map(({ label, href, icon: Icon }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-5 py-3.5 text-sm font-medium transition-colors ${
                    active ? "bg-blue-50 text-blue-600" : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </Link>
              </li>
            );
          })}
          {user ? (
            <>
              <li>
                <Link
                  href="/account"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-5 py-3.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Settings className="w-4 h-4 flex-shrink-0" />
                  Account settings
                </Link>
              </li>
              <li>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-5 py-3.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <LogOut className="w-4 h-4 flex-shrink-0" />
                  Log out
                </button>
              </li>
            </>
          ) : (
            <li>
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-5 py-3.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <UserIcon className="w-4 h-4 flex-shrink-0" />
                Sign in
              </Link>
            </li>
          )}
        </ul>
      </nav>
    </>
  );
}
