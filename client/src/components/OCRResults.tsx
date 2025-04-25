import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, AlertCircle, Check, AlertTriangle } from 'lucide-react';
import { CardFormValues } from "@shared/schema";

interface OCRResultsProps {
  loading: boolean;
  error: string | null;
  data: Partial<CardFormValues> | null;
  onApply: (data: Partial<CardFormValues>) => void;
  onCancel: () => void;
}

export default function OCRResults({ loading, error, data, onApply, onCancel }: OCRResultsProps) {
  if (loading) {
    return (
      <Card className="w-full mt-4 border border-slate-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center">
            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
            Analyzing Card Image
          </CardTitle>
          <CardDescription>
            Using OCR to analyze your card...
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-16 flex items-center justify-center">
            <p className="text-slate-500">This may take a few seconds. Tesseract.js is processing your card image to extract the details.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  if (error) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error Analyzing Image</AlertTitle>
        <AlertDescription>
          <div>
            <p>{error}</p>
            <p className="mt-2">This could be due to:</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Poor image quality or lighting</li>
              <li>Text on card not clearly visible</li>
              <li>Card at an angle making text recognition difficult</li>
            </ul>
            <p className="mt-2">You can try again with a clearer image or manually enter the card details.</p>
          </div>
        </AlertDescription>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      </Alert>
    );
  }
  
  if (!data) {
    return null;
  }
  
  return (
    <Card className="w-full mt-4 border border-slate-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center">
          <Check className="h-5 w-5 mr-2 text-green-600" />
          Card Information Found
        </CardTitle>
        <CardDescription>
          We identified the following details from your card image
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {data.sport && (
            <div className="col-span-2">
              <span className="font-medium">Sport:</span> {data.sport}
            </div>
          )}
          
          {(data.playerFirstName || data.playerLastName) && (
            <div className="col-span-2">
              <span className="font-medium">Player:</span> {data.playerFirstName} {data.playerLastName}
            </div>
          )}
          
          {data.brand && (
            <div>
              <span className="font-medium">Brand:</span> {data.brand}
            </div>
          )}
          
          {data.collection && (
            <div>
              <span className="font-medium">Collection:</span> {data.collection}
            </div>
          )}
          
          {data.cardNumber && (
            <div>
              <span className="font-medium">Card #:</span> {data.cardNumber}
            </div>
          )}
          
          {data.year && data.year > 0 && (
            <div>
              <span className="font-medium">Year:</span> {data.year}
            </div>
          )}
          
          {data.variant && (
            <div>
              <span className="font-medium">Variant:</span> {data.variant}
            </div>
          )}
          
          {data.serialNumber && (
            <div>
              <span className="font-medium">Serial #:</span> {data.serialNumber}
            </div>
          )}
          
          {data.condition && (
            <div>
              <span className="font-medium">Condition:</span> {data.condition}
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onApply(data)}>
          Apply These Details
        </Button>
      </CardFooter>
    </Card>
  );
}