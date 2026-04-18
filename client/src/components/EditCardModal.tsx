import { useEffect, useState } from "react";
import { Card as CardType, CardWithRelations, CardFormValues, cardSchema } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import EbayValueLookup from "./EbayValueLookup";
import ServerEbayLookup from "./ServerEbayLookup";
import FoilTypeSelect from "./FoilTypeSelect";

interface EditCardModalProps {
  card?: CardWithRelations | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function EditCardModal({ card, isOpen, onClose }: EditCardModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Form setup
  const form = useForm<CardFormValues>({
    resolver: zodResolver(cardSchema),
    defaultValues: {
      sport: "",
      playerFirstName: "",
      playerLastName: "",
      brand: "",
      collection: "",
      set: "",
      cardNumber: "",
      year: new Date().getFullYear(),
      variant: "",
      serialNumber: "",
      condition: "PSA 9",
      estimatedValue: 0,
      isRookieCard: false,
      isAutographed: false,
      isNumbered: false,
      notes: "",
    },
  });

  // Update form values when card changes
  useEffect(() => {
    if (card) {
      // Enhanced debugging to track exactly what values are loaded from the backend
      console.log("Card data loaded from backend:", {
        id: card.id,
        playerName: `${card.playerFirstName} ${card.playerLastName}`,
        collection: card.collection,
        variant: card.variant,
        cardNumber: card.cardNumber,
        isRookieCard: card.isRookieCard,
        isRookieCardType: typeof card.isRookieCard
      });
      
      // Log card data before loading into form
      const formData = {
        sport: card.sport?.name || "",
        playerFirstName: card.playerFirstName || "",
        playerLastName: card.playerLastName || "",
        brand: card.brand?.name || "",
        collection: card.collection || "",
        set: (card as any).set || "",
        cardNumber: card.cardNumber || "",
        year: card.year || new Date().getFullYear(),
        variant: card.variant || "",
        serialNumber: card.serialNumber || "",
        condition: card.condition || "PSA 9",
        estimatedValue: typeof card.estimatedValue === 'string' ? parseFloat(card.estimatedValue) : (card.estimatedValue || 0),
        isRookieCard: Boolean(card.isRookieCard),
        isAutographed: Boolean(card.isAutographed),
        isNumbered: Boolean(card.isNumbered),
        notes: card.notes || "",
      };
      
      console.log("Form data being loaded:", formData);
      
      form.reset(formData);
    }
  }, [card, form]);
  
  // Monitor form value changes for debugging
  useEffect(() => {
    const collection = form.watch('collection');
    console.log(`Collection value changed to: "${collection}"`);
    
    // Log all current form values for debugging
    const formValues = {
      playerFirstName: form.watch('playerFirstName'),
      playerLastName: form.watch('playerLastName'),
      cardNumber: form.watch('cardNumber'),
      brand: form.watch('brand'),
      year: form.watch('year'),
      collection,
      variant: form.watch('variant')
    };
    console.log('Current form values:', formValues);
  }, [form.watch('collection')]);

  // Update card mutation
  const updateCardMutation = useMutation({
    mutationFn: async (data: CardFormValues) => {
      if (!card) return null;
      
      // Log what's being saved to the server
      console.log('Saving card data to server:', data);
      
      return apiRequest(`/api/cards/${card.id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    },
    onSuccess: async () => {
      try {
        // Invalidate cards query to refresh the list
        await queryClient.invalidateQueries({ queryKey: ['/api/cards'] });
        // Also invalidate stats
        await queryClient.invalidateQueries({ queryKey: ['/api/collection/summary'] });
        
        // Ensure the card data is fully refreshed before closing
        if (card && card.id) {
          console.log(`Explicitly refreshing card data for ID: ${card.id}`);
          await queryClient.invalidateQueries({ queryKey: [`/api/cards/${card.id}`] });
        }
        
        toast({
          title: "Card Updated",
          description: "The card has been successfully updated with your changes.",
        });
        
        // Use a more React-friendly approach to refresh data
        console.log("Triggering collection page refresh after card update...");
        
        // Close modal first to prevent any state conflicts
        onClose();
        
        // Trigger refresh using localStorage event for components listening for changes
        localStorage.setItem('card_edited', Date.now().toString());
        
        // Navigate to collection page with a refresh parameter
        setTimeout(() => {
          window.location.href = '/collection?refresh=true';
        }, 300);
      } catch (error) {
        console.error("Error during card update cleanup:", error);
      }
    },
    onError: (err) => {
      console.error("Error updating card:", err);
      toast({
        title: "Error",
        description: "There was an error updating the card. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: CardFormValues) => {
    updateCardMutation.mutate(values);
  };

  // Watch brand/year/collection so the Collection + Set dropdowns can refresh
  // when the user changes any upstream field. Both dropdowns are populated
  // from card_database via /api/card-database/{collections,sets}.
  const watchedBrand = form.watch('brand');
  const watchedYear = form.watch('year');
  const watchedCollection = form.watch('collection');
  const watchedSet = form.watch('set');
  const watchedPlayerLastName = form.watch('playerLastName');

  const [collectionOptions, setCollectionOptions] = useState<string[]>([]);
  const [setOptions, setSetOptions] = useState<string[]>([]);
  // "Other" mode lets the user free-type a value not present in the DB list.
  const [collectionOther, setCollectionOther] = useState(false);
  const [setOther, setSetOther] = useState(false);

  // Sentinel select value used for the "Other / not listed" choice. Selecting
  // it switches the field over to a free-text Input.
  const OTHER_VALUE = '__other__';

  useEffect(() => {
    if (!watchedBrand || !watchedYear) {
      setCollectionOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(watchedBrand),
      year: String(watchedYear),
    });
    if (watchedPlayerLastName) params.set('playerLastName', String(watchedPlayerLastName));
    fetch(`/api/card-database/collections?${params.toString()}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setCollectionOptions(data); })
      .catch(() => setCollectionOptions([]));
  }, [watchedBrand, watchedYear, watchedPlayerLastName]);

  // Sets are scoped to brand+year+player. We deliberately do NOT cascade the
  // selected Collection here because Set is now displayed ABOVE Collection —
  // the user picks Set first and Collection narrows from there.
  useEffect(() => {
    if (!watchedBrand || !watchedYear) {
      setSetOptions([]);
      return;
    }
    const params = new URLSearchParams({
      brand: String(watchedBrand),
      year: String(watchedYear),
    });
    if (watchedPlayerLastName) params.set('playerLastName', String(watchedPlayerLastName));
    fetch(`/api/card-database/sets?${params.toString()}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSetOptions(data); })
      .catch(() => setSetOptions([]));
  }, [watchedBrand, watchedYear, watchedPlayerLastName]);

  // When the upstream brand/year/player changes, reset the "Other" toggles so
  // the user sees the refreshed dropdown rather than being stuck in free-text.
  useEffect(() => {
    setCollectionOther(false);
    setSetOther(false);
  }, [watchedBrand, watchedYear, watchedPlayerLastName]);

  return (
    <Dialog 
      open={isOpen} 
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent 
        className="max-w-2xl overflow-y-auto max-h-[90vh]"
      >
        <DialogHeader>
          <DialogTitle>Edit Card</DialogTitle>
          <DialogDescription>
            Update the details for this card.
          </DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            {/* Field order (per UX preference):
                  Sport · First Name · Last Name · Year · Brand · Card # ·
                  Set · Collection · Parallel · Serial # · Variant · Rookie Card
                Each field is on its own row (full-width) so Set is unambiguously
                ABOVE Collection and Parallel ABOVE Serial #. */}

            {/* Sport */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="sport"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
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
            </div>

            {/* First Name + Last Name (kept side-by-side as a natural pair) */}
            <div className="form-grid">
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

            {/* Year */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="year"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Year <span className="text-red-500">*</span></FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="e.g. 2024"
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value) || '')}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Brand */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="brand"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Brand <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select brand" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["Topps", "Panini", "Upper Deck", "Bowman", "Fleer", "Donruss", "Score", "Other"].map((brand) => (
                          <SelectItem key={brand} value={brand}>{brand}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Card Number */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="cardNumber"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Card Number</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 42, BP-12" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Set (DB-driven, filtered by Brand + Year + Player). Includes
                an "Other" option that reveals a free-text input. */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="set"
                render={({ field }) => {
                  const showInput = setOther || setOptions.length === 0
                    || (!!field.value && !setOptions.includes(field.value));
                  return (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Set</FormLabel>
                      {!showInput ? (
                        <Select
                          onValueChange={(v) => {
                            if (v === OTHER_VALUE) {
                              setSetOther(true);
                              field.onChange('');
                            } else {
                              field.onChange(v);
                            }
                          }}
                          value={field.value || ''}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select set" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {setOptions.map((s) => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                            <SelectItem value={OTHER_VALUE}>Other…</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <FormControl>
                          <Input
                            placeholder={watchedBrand && watchedYear ? "Type a set name" : "Pick brand & year first"}
                            {...field}
                            value={field.value || ''}
                          />
                        </FormControl>
                      )}
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>

            {/* Collection (DB-driven). Includes "Other". */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="collection"
                render={({ field }) => {
                  const showInput = collectionOther || collectionOptions.length === 0
                    || (!!field.value && !collectionOptions.includes(field.value));
                  return (
                    <FormItem className="col-span-1 md:col-span-2">
                      <FormLabel>Collection</FormLabel>
                      {!showInput ? (
                        <Select
                          onValueChange={(v) => {
                            if (v === OTHER_VALUE) {
                              setCollectionOther(true);
                              field.onChange('');
                            } else {
                              field.onChange(v);
                            }
                          }}
                          value={field.value || ''}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select collection" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {collectionOptions.map((c) => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                            <SelectItem value={OTHER_VALUE}>Other…</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <FormControl>
                          <Input
                            placeholder={watchedBrand && watchedYear ? "Type a collection name" : "Pick brand & year first"}
                            {...field}
                            value={field.value || ''}
                          />
                        </FormControl>
                      )}
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>

            {/* Parallel — only shows parallels matching the card's serialization
                status (defaults to non-serialized when not numbered) */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="foilType"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Parallel</FormLabel>
                    <FormControl>
                      <FoilTypeSelect
                        brand={watchedBrand}
                        year={watchedYear as number | undefined}
                        collection={watchedCollection}
                        set={watchedSet}
                        value={(field.value as string) || ''}
                        isNumbered={!!form.watch('isNumbered')}
                        onChange={(foilType) => {
                          field.onChange(foilType);
                          form.setValue('isFoil' as any, !!foilType);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Serial Number */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="serialNumber"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Serial Number</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 42/100" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Variant (free-text only) */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="variant"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Variant</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. SSP, Photo Variation" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Condition */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="condition"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Condition <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select condition" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["PSA 10", "PSA 9", "PSA 8", "PSA 7", "PSA 6", "PSA 5", "Raw-Mint", "Raw-Good", "Raw-Poor"].map((condition) => (
                          <SelectItem key={condition} value={condition}>{condition}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="condition"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Condition <span className="text-red-500">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select condition" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {["PSA 10", "PSA 9", "PSA 8", "PSA 7", "PSA 6", "PSA 5", "Raw-Mint", "Raw-Good", "Raw-Poor"].map((condition) => (
                          <SelectItem key={condition} value={condition}>{condition}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            {/* Card Features */}
            <div className="mt-2">
              <h3 className="text-sm font-medium text-slate-700 mb-2">Card Features</h3>
              <div className="flex flex-wrap gap-6">
                <FormField
                  control={form.control}
                  name="isRookieCard"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value === true}
                          onCheckedChange={(checked) => {
                            field.onChange(checked === true);
                            console.log("Rookie checkbox changed to:", checked);
                          }}
                          className="h-5 w-5"
                        />
                      </FormControl>
                      <FormLabel className="font-normal text-sm ml-2">Rookie Card</FormLabel>
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="isAutographed"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value === true}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                          className="h-5 w-5"
                        />
                      </FormControl>
                      <FormLabel className="font-normal text-sm ml-2">Autographed</FormLabel>
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="isNumbered"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value === true}
                          onCheckedChange={(checked) => field.onChange(checked === true)}
                          className="h-5 w-5"
                        />
                      </FormControl>
                      <FormLabel className="font-normal text-sm ml-2">Numbered</FormLabel>
                    </FormItem>
                  )}
                />
              </div>
            </div>
            
            {/* eBay Value Lookup and Estimated Value Field */}
            <div className="form-grid mb-4">
              <div className="col-span-1 md:col-span-2">
                <FormLabel>Card Value</FormLabel>
                
                {/* eBay Value Lookup */}
                <div className="mb-4">
                  <EbayValueLookup
                    playerName={`${form.watch('playerFirstName')} ${form.watch('playerLastName')}`.trim()}
                    cardNumber={form.watch('cardNumber')}
                    brand={form.watch('brand')}
                    year={form.watch('year') || new Date().getFullYear()}
                    collection={form.watch('collection')}
                    variant={form.watch('variant')}
                    condition={form.watch('condition')}
                    onValueSelect={(value) => form.setValue('estimatedValue', value)}
                  />
                </div>
              </div>
            </div>
            
            {/* Estimated Value Field */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="estimatedValue"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Estimated Value ($) <span className="text-red-500">*</span></FormLabel>
                    <div className="flex flex-col space-y-2">
                      <FormControl>
                        <div className="relative">
                          <Input
                            type="number"
                            placeholder="Card value in USD"
                            {...field}
                            value={field.value === 0 ? '' : field.value}
                            onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                            className="pl-7"
                          />
                          <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                            <span className="text-gray-500">$</span>
                          </div>
                        </div>
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            {/* Notes Field */}
            <div className="form-grid">
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="col-span-1 md:col-span-2">
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Input placeholder="Any additional details about the card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <DialogFooter>
              <DialogClose asChild>
                <Button 
                  type="button" 
                  variant="outline"
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button 
                type="submit" 
                className="bg-green-600 hover:bg-green-500 active:bg-green-700 text-white"
                disabled={updateCardMutation.isPending}
              >
                {updateCardMutation.isPending ? "Updating..." : "Update Card"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}