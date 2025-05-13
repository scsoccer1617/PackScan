import { useLocation } from "wouter";

interface BottomNavigationProps {
  activeTab: 'add' | 'collection' | 'stats';
  setActiveTab: (tab: 'add' | 'collection' | 'stats') => void;
}

export default function BottomNavigation({ activeTab, setActiveTab }: BottomNavigationProps) {
  const [location, navigate] = useLocation();

  const handleNavigate = (tab: 'add' | 'collection' | 'stats') => {
    setActiveTab(tab);
    
    if (tab === 'add') {
      navigate('/');
    } else if (tab === 'collection') {
      navigate('/collection');
    } else if (tab === 'stats') {
      navigate('/stats');
    }
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-lg flex justify-around items-center h-16 max-w-lg mx-auto z-50">
      <button 
        className={`flex flex-col items-center justify-center w-1/3 h-full ${activeTab === 'add' ? 'text-primary-600' : 'text-slate-500'}`}
        onClick={() => handleNavigate('add')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-xs mt-1">Add Card</span>
      </button>
      <button 
        className={`flex flex-col items-center justify-center w-1/3 h-full ${activeTab === 'collection' ? 'text-primary-600' : 'text-slate-500'}`}
        onClick={() => handleNavigate('collection')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
        </svg>
        <span className="text-xs mt-1">Collection</span>
      </button>
      <button 
        className={`flex flex-col items-center justify-center w-1/3 h-full ${activeTab === 'stats' ? 'text-primary-600' : 'text-slate-500'}`}
        onClick={() => handleNavigate('stats')}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <span className="text-xs mt-1">Stats</span>
      </button>
    </nav>
  );
}
