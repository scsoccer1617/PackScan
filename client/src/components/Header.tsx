export default function Header() {
  return (
    <header className="sticky top-0 z-10 bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-4">
        <div className="flex items-center space-x-2">
          <span className="text-primary-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </span>
          <h1 className="text-xl font-semibold text-primary-700">ScanDeck</h1>
        </div>
      </div>
    </header>
  );
}
