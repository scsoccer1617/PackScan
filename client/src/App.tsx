import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import NotFound from "@/pages/not-found";
import AddCard from "@/pages/AddCard";
import Collection from "@/pages/Collection";
import Stats from "@/pages/Stats";
import Header from "@/components/Header";
import BottomNavigation from "@/components/BottomNavigation";
import { useState } from "react";

function App() {
  const [activeTab, setActiveTab] = useState<'add' | 'collection' | 'stats'>('add');

  return (
    <QueryClientProvider client={queryClient}>
      <div className="max-w-lg mx-auto min-h-screen flex flex-col bg-white relative">
        <Header activeTab={activeTab} setActiveTab={setActiveTab} />
        
        <main className="flex-1 overflow-y-auto pb-20">
          <Switch>
            <Route path="/" component={() => <AddCard />} />
            <Route path="/collection" component={() => <Collection />} />
            <Route path="/stats" component={() => <Stats />} />
            <Route component={NotFound} />
          </Switch>
        </main>
        
        <BottomNavigation activeTab={activeTab} setActiveTab={setActiveTab} />
      </div>
    </QueryClientProvider>
  );
}

export default App;
