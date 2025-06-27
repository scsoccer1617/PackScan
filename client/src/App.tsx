import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import NotFound from "@/pages/not-found";
import PriceLookup from "@/pages/PriceLookup";
import Header from "@/components/Header";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="max-w-lg mx-auto min-h-screen flex flex-col bg-white relative">
        <Header />
        
        <main className="flex-1 overflow-y-auto">
          <Switch>
            <Route path="/" component={() => <PriceLookup />} />
            <Route component={NotFound} />
          </Switch>
          
          {/* Small bottom spacer for all pages */}
          <div className="w-full h-8"></div>
        </main>
      </div>
    </QueryClientProvider>
  );
}

export default App;
