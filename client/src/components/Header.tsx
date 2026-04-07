import scanDeckLogo from "@assets/ScanDeck_Logo_Transparent_1024_1770993832380.png";
import { Link, useLocation } from "wouter";
import { Database, Search } from "lucide-react";

export default function Header() {
  const [location] = useLocation();
  const isAdmin = location.startsWith("/admin");
  const isSearch = location === "/search";

  return (
    <header className="sticky top-0 z-10 bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-4">
        <Link href="/" className="flex items-center space-x-2">
          <img src={scanDeckLogo} alt="ScanDeck" className="h-8 w-8 rounded" />
          <h1 className="text-xl font-semibold text-primary-700">PackScan</h1>
        </Link>
        <div className="flex items-center gap-1">
          <Link
            href="/search"
            className={`p-1.5 rounded-md transition-colors ${isSearch ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"}`}
            title="Search Cards"
          >
            <Search className="w-4 h-4" />
          </Link>
          <Link
            href="/admin/card-database"
            className={`p-1.5 rounded-md transition-colors ${isAdmin ? "bg-blue-100 text-blue-600" : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"}`}
            title="Card Database Admin"
          >
            <Database className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}
