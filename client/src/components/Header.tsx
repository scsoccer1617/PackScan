import { Link, useLocation } from "wouter";

interface HeaderProps {
  activeTab: 'add' | 'collection' | 'stats';
  setActiveTab: (tab: 'add' | 'collection' | 'stats') => void;
}

export default function Header({ activeTab, setActiveTab }: HeaderProps) {
  const [location, navigate] = useLocation();

  const handleTabChange = (tab: 'add' | 'collection' | 'stats') => {
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
    <header className="sticky top-0 z-10 bg-white shadow-sm">
      <div className="flex justify-between items-center px-4 py-3">
        <div className="flex items-center space-x-2">
          <span className="text-primary-600">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </span>
          <h1 className="text-xl font-semibold text-primary-700">SportCardCatalog</h1>
        </div>
        <div className="flex items-center space-x-3">
          <button className="p-2 rounded-full hover:bg-slate-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <button className="p-2 rounded-full hover:bg-slate-100">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>
      
      {/* Tab Navigation */}
      <div className="flex text-sm border-b">
        <button 
          className={`flex-1 py-3 font-medium ${activeTab === 'add' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-slate-500'}`}
          onClick={() => handleTabChange('add')}
        >
          Add Card
        </button>
        <button 
          className={`flex-1 py-3 font-medium ${activeTab === 'collection' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-slate-500'}`}
          onClick={() => handleTabChange('collection')}
        >
          My Collection
        </button>
        <button 
          className={`flex-1 py-3 font-medium ${activeTab === 'stats' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-slate-500'}`}
          onClick={() => handleTabChange('stats')}
        >
          Stats
        </button>
      </div>
    </header>
  );
}
