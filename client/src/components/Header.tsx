import { useState } from "react";
import packScanLogo from "@assets/ScanDeck_Final_Header_1776091120026.png";
import { Link, useLocation } from "wouter";
import { Menu, X, Home, Camera, Search } from "lucide-react";

const NAV_ITEMS = [
  { label: "Home", href: "/", icon: Home },
  { label: "Scan Cards", href: "/scan", icon: Camera },
  { label: "Manual Lookup", href: "/search", icon: Search },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  return (
    <>
      <header className="sticky top-0 z-30 bg-white shadow-sm">
        <div className="flex justify-between items-center px-4 py-4">
          <Link href="/" className="flex items-center space-x-2" onClick={() => setOpen(false)}>
            <img src={packScanLogo} alt="PackScan" className="h-8 w-8 rounded" />
            <h1 className="text-xl font-semibold text-primary-700">PackScan</h1>
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

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/20"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Slide-down menu */}
      <nav
        className={`fixed top-[57px] left-0 right-0 z-20 bg-white shadow-lg border-t border-gray-100 transition-all duration-200 max-w-lg mx-auto ${
          open ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 -translate-y-2 pointer-events-none"
        }`}
      >
        <ul className="py-2">
          {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-5 py-3.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-blue-50 text-blue-600"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
