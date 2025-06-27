export default function Header() {
  return (
    <header className="sticky top-0 z-10 bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-4">
        <div className="flex items-center space-x-2">
          <span className="text-primary-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
            </svg>
          </span>
          <h1 className="text-xl font-semibold text-primary-700">Sports Card Price Lookup</h1>
        </div>
      </div>
    </header>
  );
}
