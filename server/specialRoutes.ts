import { Router } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

// Special handler for problematic card images
router.get('/special-card-image/:id/:side', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const side = req.params.side; // 'front' or 'back'
  
  if (isNaN(id) || (side !== 'front' && side !== 'back')) {
    return res.status(400).json({ error: 'Invalid card ID or side' });
  }
  
  let imagePath = '';
  
  // Map specific card IDs to their image paths
  if (id === 31) { // Bobby Thigpen
    imagePath = side === 'front' 
      ? '/uploads/1748185000000_Thigpen_front.jpg'
      : '/uploads/1748185000001_Thigpen_back.jpg';
  } else if (id === 32) { // Chris James
    imagePath = side === 'front'
      ? '/uploads/1748185000002_James_front.jpg'
      : '/uploads/1748185000003_James_back.jpg';
  } else {
    return res.status(404).json({ error: 'Special card not found' });
  }
  
  const filePath = path.join(process.cwd(), imagePath);
  
  if (fs.existsSync(filePath)) {
    console.log(`Serving special ${side} image for card ID ${id}: ${imagePath}`);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(filePath);
  } else {
    console.log(`Special image file not found for card ID ${id}: ${filePath}`);
    return res.status(404).json({ error: 'Image file not found' });
  }
});

export default router;