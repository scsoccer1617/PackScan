import scanDeckLogo from "@assets/ScanDeck_Logo_Transparent_1024_1770993832380.png";

export default function Header() {
  return (
    <header className="sticky top-0 z-10 bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-4">
        <div className="flex items-center space-x-2">
          <img src={scanDeckLogo} alt="ScanDeck" className="h-8 w-8 rounded" />
          <h1 className="text-xl font-semibold text-primary-700">ScanDeck</h1>
        </div>
      </div>
    </header>
  );
}
