import { useState } from "react";
import SimpleImageUploader from "@/components/SimpleImageUploader";
import { Button } from "@/components/ui/button";
import { ScanSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CardFormValues, cardSchema } from "@shared/schema";

export default function SimpleCardForm() {
  const [frontImage, setFrontImage] = useState<string>("");
  const [backImage, setBackImage] = useState<string>("");
  
  const form = useForm<CardFormValues>({
    resolver: zodResolver(cardSchema),
    defaultValues: {
      sport: "Baseball",
      playerFirstName: "",
      playerLastName: "",
      brand: "Topps",
      collection: "",
      cardNumber: "",
      year: new Date().getFullYear(),
      variant: "",
      serialNumber: "",
      condition: "PSA 9",
      estimatedValue: 200,
    },
  });
  
  const handleSubmit = (data: CardFormValues) => {
    // Here would go the code to save the card data
    console.log("Form submitted:", data);
    console.log("Front image:", frontImage);
    console.log("Back image:", backImage);
  };
  
  return (
    <div className="p-4">
      <Card className="shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-2xl font-bold text-slate-800">
            Add to Collection
          </CardTitle>
          <CardDescription>
            Capture both front and back of your card for complete documentation.
          </CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-4">
          <div className="mb-6">
            <h3 className="text-lg font-medium text-slate-700 mb-2">Card Images</h3>
            
            <div className="grid grid-cols-2 gap-4">
              <SimpleImageUploader 
                label="Front"
                existingImage={frontImage}
                onImageCaptured={setFrontImage}
              />
              
              <SimpleImageUploader 
                label="Back"
                existingImage={backImage}
                onImageCaptured={setBackImage}
              />
            </div>
            
            {frontImage && (
              <Button 
                type="button" 
                variant="secondary" 
                size="sm" 
                className="w-full mt-2"
              >
                <ScanSearch className="h-4 w-4 mr-2" />
                Analyze Card with OCR
              </Button>
            )}
          </div>
          
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="sport"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sport <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select sport" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"].map((sport) => (
                          <SelectItem key={sport} value={sport}>{sport}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="playerFirstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="First name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="playerLastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name <span className="text-red-500">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="Last name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              
              <Button 
                type="submit" 
                className="w-full bg-slate-800 hover:bg-slate-700 text-white"
              >
                Add to Collection
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}