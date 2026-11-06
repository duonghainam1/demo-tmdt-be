const adminMiddleware = (req, res, next) => {
  try {
    const user = req.user;    
    if (!user || user.role?.code !== "ADMIN") {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }

    next();
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Internal server error" });
  }
};
export default adminMiddleware;
