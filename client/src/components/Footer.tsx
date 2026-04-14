import { Link } from "wouter";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-gray-100 bg-white py-4 px-6 flex items-center justify-between text-xs text-gray-400">
      <span>© {year} PackScan. All rights reserved.</span>
      <Link href="/admin/card-database" className="text-gray-400 hover:text-gray-600 transition-colors">
        Admin
      </Link>
    </footer>
  );
}
